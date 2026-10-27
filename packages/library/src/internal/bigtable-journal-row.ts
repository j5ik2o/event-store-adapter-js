import { EventStoreError } from "../event-store-error";
import { flagOf } from "./bigtable-head";
import {
  EVENT_ENVELOPE,
  EVENT_HAS_SNAPSHOT,
  FAMILY_EVENT,
  FAMILY_HISTORY,
  HISTORY_ENVELOPE,
  HISTORY_STATE,
  latestCell,
  latestCellExists,
  STATE_ACTIVE,
  STATE_RETIRED,
  setCell,
} from "./bigtable-request-parts";
import type { BigtableTableRequests } from "./bigtable-requests";
import { cellValue } from "./bigtable-row";
import { journalRowKey } from "./bigtable-row-keys";

const invalid = (message: string) => EventStoreError.storage(message);
const same = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  a !== undefined && Buffer.from(a).equals(Buffer.from(b));

/**
 * journal の行を、event:envelope がない場合だけ、イベント・フラグ・必要な履歴を 1 回の CheckAndMutateRow で作る（BT-5）。
 * 既存の行は上書きせず、イベントとフラグを照合する。履歴を伴う行が active なら履歴の封筒も照合する。
 * retired の行や、履歴を持たない行の履歴は作り直さない。遅れた書き出しが削除済みの履歴を復活させない。
 */
export async function writeJournalRow(
  journal: BigtableTableRequests,
  prefix: Uint8Array,
  seqNr: number,
  event: Uint8Array,
  history: Uint8Array | undefined,
  hasSnapshot: boolean,
): Promise<void> {
  const rowKey = journalRowKey(prefix, seqNr);
  const creation = [
    setCell(FAMILY_EVENT, EVENT_ENVELOPE, event),
    setCell(FAMILY_EVENT, EVENT_HAS_SNAPSHOT, flagOf(hasSnapshot)),
    ...(history === undefined
      ? []
      : [
          setCell(FAMILY_HISTORY, HISTORY_STATE, STATE_ACTIVE),
          setCell(FAMILY_HISTORY, HISTORY_ENVELOPE, history),
        ]),
  ];
  const existed = await journal.checkAndMutate(
    rowKey,
    latestCellExists(FAMILY_EVENT, EVENT_ENVELOPE),
    [],
    creation,
  );
  if (!existed) return;
  const row = await journal.readRow(rowKey, latestCell());
  if (row === undefined)
    throw invalid("an existing journal row disappeared while it was verified");
  if (!same(cellValue(row, FAMILY_EVENT, EVENT_ENVELOPE), event))
    throw invalid("an existing journal row holds a different event envelope");
  if (
    !same(cellValue(row, FAMILY_EVENT, EVENT_HAS_SNAPSHOT), flagOf(hasSnapshot))
  )
    throw invalid(
      "an existing journal row holds a different has_snapshot flag",
    );
  if (history === undefined) return;
  const state = cellValue(row, FAMILY_HISTORY, HISTORY_STATE);
  // 保持件数を設定する前に作られた行は、履歴を補作しない。
  if (state === undefined) return;
  if (same(state, STATE_RETIRED)) return;
  if (!same(state, STATE_ACTIVE))
    throw invalid("an existing journal row holds an unknown history state");
  if (!same(cellValue(row, FAMILY_HISTORY, HISTORY_ENVELOPE), history))
    throw invalid(
      "an existing journal row holds a missing or different history envelope",
    );
}
