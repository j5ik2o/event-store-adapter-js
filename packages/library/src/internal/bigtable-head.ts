import { EventStoreError } from "../event-store-error";
import {
  decodeEventEnvelope,
  decodeSnapshotEnvelope,
} from "./bigtable-envelope";
import type { BigtableHeadState } from "./bigtable-head-state";
import type { BigtableMutation } from "./bigtable-mutation";
import {
  FAMILY_HEAD,
  FAMILY_SNAPSHOT,
  FLAG_SET,
  FLAG_UNSET,
  HEAD_HAS_SNAPSHOT,
  HEAD_LAST_EVENT,
  HEAD_SEQ_NR,
  latestCell,
  latestCellEquals,
  latestCellExists,
  replaceCell,
  SNAPSHOT_CURRENT,
  setCell,
} from "./bigtable-request-parts";
import type { BigtableTableRequests } from "./bigtable-requests";
import { cellValue } from "./bigtable-row";

const MAX_SEQ_NR = Number.MAX_SAFE_INTEGER;

const invalid = (message: string) => EventStoreError.storage(message);

/** head:seq_nr に保存する、20 桁のゼロ詰めの ASCII 数字。 */
export const formatHeadSeqNr = (seqNr: number): Buffer =>
  Buffer.from(String(seqNr).padStart(20, "0"));

/** 20 桁の ASCII 数字で、1 以上 2^53-1 以下のときだけ値を返す。 */
function parseHeadSeqNr(bytes: Uint8Array | undefined): number | undefined {
  if (bytes === undefined || bytes.length !== 20) return undefined;
  const text = Buffer.from(bytes).toString("latin1");
  if (!/^[0-9]{20}$/.test(text)) return undefined;
  const value = BigInt(text);
  return value >= BigInt(1) && value <= BigInt(MAX_SEQ_NR)
    ? Number(value)
    : undefined;
}

export const flagOf = (hasSnapshot: boolean): Buffer =>
  hasSnapshot ? FLAG_SET : FLAG_UNSET;

function parseFlag(bytes: Uint8Array | undefined): boolean {
  if (bytes !== undefined && Buffer.from(bytes).equals(FLAG_SET)) return true;
  if (bytes !== undefined && Buffer.from(bytes).equals(FLAG_UNSET))
    return false;
  throw invalid("a stored has_snapshot flag is missing or invalid");
}

/**
 * head の行を強整合で読み、検証する。行がなければ undefined。
 * 必要なセルが欠けた行は新規集約とみなさず、保存先エラーにする。
 */
export async function readHead(
  head: BigtableTableRequests,
  prefix: Uint8Array,
  aid: string,
): Promise<BigtableHeadState | undefined> {
  const row = await head.readRow(prefix, latestCell());
  if (row === undefined) return undefined;
  const seqNr = parseHeadSeqNr(cellValue(row, FAMILY_HEAD, HEAD_SEQ_NR));
  if (seqNr === undefined)
    throw invalid("the head row has a missing or invalid seq_nr");
  const lastEventBytes = cellValue(row, FAMILY_HEAD, HEAD_LAST_EVENT);
  if (lastEventBytes === undefined)
    throw invalid("the head row has no last event");
  const lastEvent = decodeEventEnvelope(lastEventBytes);
  if (lastEvent.aid !== aid || lastEvent.seqNr !== seqNr)
    throw invalid("the last event of the head row does not match the head");
  const hasSnapshot = parseFlag(cellValue(row, FAMILY_HEAD, HEAD_HAS_SNAPSHOT));
  const currentBytes = cellValue(row, FAMILY_SNAPSHOT, SNAPSHOT_CURRENT);
  const currentSnapshot =
    currentBytes === undefined
      ? undefined
      : Object.freeze({
          bytes: currentBytes,
          fields: decodeSnapshotEnvelope(currentBytes),
        });
  // head が伴う（has_snapshot = 1）なら現在のスナップショットは head と同じ seq_nr で、
  // 伴わないなら head より小さい。
  let tailSnapshotBytes: Uint8Array | undefined;
  if (currentSnapshot === undefined) {
    if (hasSnapshot)
      throw invalid("the head row says it has a snapshot but holds none");
  } else if (hasSnapshot) {
    if (currentSnapshot.fields.seqNr !== seqNr)
      throw invalid("the current snapshot does not match the head seq_nr");
    tailSnapshotBytes = currentSnapshot.bytes;
  } else if (currentSnapshot.fields.seqNr >= seqNr) {
    throw invalid("the current snapshot does not match the head seq_nr");
  }
  return Object.freeze({
    seqNr,
    lastEventBytes,
    lastEvent,
    hasSnapshot,
    tailSnapshotBytes,
    currentSnapshot,
  });
}

/**
 * head の行を条件付きで更新する。成功が追記の確定点である（H-1）。
 * 条件が成り立たなければ楽観ロックにする。不成立は別の書き手が head を進めた後なので、head を読み直さない。
 * 応答を受け取れなかったときは結果を決めつけず保存先エラーにし、再送しない。
 */
export async function commitHead(
  head: BigtableTableRequests,
  aid: string,
  prefix: Uint8Array,
  seqNr: number,
  previous: number | undefined,
  event: Uint8Array,
  snapshot: Uint8Array | undefined,
): Promise<void> {
  const flag = flagOf(snapshot !== undefined);
  let succeeded: boolean;
  if (previous === undefined) {
    // 新規作成は、head:seq_nr がまだない側で初期化する。先行する作成があれば条件が成立する。
    const mutations: BigtableMutation[] = [
      setCell(FAMILY_HEAD, HEAD_SEQ_NR, formatHeadSeqNr(seqNr)),
      setCell(FAMILY_HEAD, HEAD_LAST_EVENT, event),
      setCell(FAMILY_HEAD, HEAD_HAS_SNAPSHOT, flag),
      ...(snapshot === undefined
        ? []
        : [setCell(FAMILY_SNAPSHOT, SNAPSHOT_CURRENT, snapshot)]),
    ];
    succeeded = !(await head.checkAndMutate(
      prefix,
      latestCellExists(FAMILY_HEAD, HEAD_SEQ_NR),
      [],
      mutations,
    ));
  } else {
    // 更新は、head:seq_nr の最新の 1 セルが取得した h の側だけで行う。
    const mutations: BigtableMutation[] = [
      ...replaceCell(FAMILY_HEAD, HEAD_SEQ_NR, formatHeadSeqNr(seqNr)),
      ...replaceCell(FAMILY_HEAD, HEAD_LAST_EVENT, event),
      ...replaceCell(FAMILY_HEAD, HEAD_HAS_SNAPSHOT, flag),
      ...(snapshot === undefined
        ? []
        : replaceCell(FAMILY_SNAPSHOT, SNAPSHOT_CURRENT, snapshot)),
    ];
    succeeded = await head.checkAndMutate(
      prefix,
      latestCellEquals(FAMILY_HEAD, HEAD_SEQ_NR, formatHeadSeqNr(previous)),
      mutations,
      [],
    );
  }
  if (!succeeded)
    throw EventStoreError.optimisticLockConflict({ aggregateId: aid, seqNr });
}
