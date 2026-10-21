import { AggregateId } from "../aggregate-id";
import { EventEnvelope } from "../event-envelope";
import type { PayloadSerializer } from "../payload-serializer";
import { Result } from "../result";
import { SnapshotEnvelope } from "../snapshot-envelope";
import type { SpannerMigrationInput } from "../spanner-migration-input";
import type { SpannerMigrationJournalRow } from "../spanner-migration-journal-row";
import type { SpannerMigrationRejection } from "../spanner-migration-rejection";
import type { SpannerMigrationRestoredEvent } from "../spanner-migration-restored-event";
import type { SpannerMigrationSnapshotRow } from "../spanner-migration-snapshot-row";
import type { SpannerMigrationSource } from "./spanner-migration-read";
import { spannerStoredInteger } from "./spanner-stored-integer";

export type SpannerMigrationAggregatePlan<PE, PS> = Readonly<{
  /** v4 の aggregate_id。 */
  v4AggregateId: string;
  id: AggregateId;
  /** seq_nr の昇順。 */
  events: readonly EventEnvelope<PE>[];
  /** 移すスナップショット。なければイベントだけを移す。 */
  snapshot: SnapshotEnvelope<PS> | undefined;
}>;

export type SpannerMigrationPlan<PE, PS> =
  readonly SpannerMigrationAggregatePlan<PE, PS>[];

const INT64_MIN = BigInt("-9223372036854775808");
const INT64_MAX = BigInt("9223372036854775807");
const MAX_SEQ_NR = BigInt(Number.MAX_SAFE_INTEGER);

type Serializers<PE, PS> = Readonly<{
  eventSerializer: PayloadSerializer<PE>;
  snapshotSerializer: PayloadSerializer<PS>;
}>;

type ParsedJournal = Readonly<{
  aggregateId: string;
  shardId: string;
  seq: number | undefined;
  row: SpannerMigrationJournalRow | undefined;
}>;

type Restoration<PE> =
  | Readonly<{
      type: "refused";
      row: SpannerMigrationJournalRow;
      error: string;
    }>
  | Readonly<{
      type: "restored";
      row: SpannerMigrationJournalRow;
      restored: SpannerMigrationRestoredEvent<PE>;
    }>;

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

// NOTE: 局所の蓄積用コレクションを関数の内側で変更する。要素ごとに Map 全体を複製すると 2 乗の計算量になるため。
const group = <T>(
  items: readonly T[],
  key: (item: T) => string,
): ReadonlyMap<string, readonly T[]> => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const members = groups.get(k);
    if (members === undefined) groups.set(k, [item]);
    else members.push(item);
  }
  return groups;
};

/** journal の 1 行を解釈する。拒む場合は理由を返す。入出力は持たない。 */
function parseJournalRow(
  raw: Record<string, unknown>,
  table: string,
): Result<ParsedJournal, SpannerMigrationRejection> {
  const aggregateId = raw.aggregate_id;
  const shard = spannerStoredInteger(
    raw.shard_id,
    "shard_id",
    INT64_MIN,
    INT64_MAX,
  );
  if (typeof aggregateId !== "string" || shard.type === "err") {
    return Result.err({
      table,
      ...(typeof aggregateId === "string" ? { aggregateId } : {}),
      reason: "invalid aggregate_id or shard_id",
    });
  }
  const shardId = shard.value.toString();
  const base = { table, aggregateId, shardId };
  const seq = spannerStoredInteger(
    raw.sequence_number,
    "sequence_number",
    BigInt(1),
    MAX_SEQ_NR,
  );
  if (seq.type === "err") {
    return Result.err({
      ...base,
      reason: "sequence_number must be 1 or greater",
    });
  }
  const sequenceNumber = Number(seq.value);
  const withSeq = { ...base, sequenceNumber };
  if (raw.millisecond_precision !== true) {
    return Result.err({
      ...withSeq,
      reason: "occurred_at is finer than a millisecond",
    });
  }
  const millis = spannerStoredInteger(
    raw.occurred_at_ms,
    "occurred_at",
    INT64_MIN,
    INT64_MAX,
  );
  const payload = raw.payload;
  if (millis.type === "err" || !(payload instanceof Uint8Array)) {
    return Result.err({ ...withSeq, reason: "invalid occurred_at or payload" });
  }
  return Result.ok({
    aggregateId,
    shardId,
    seq: sequenceNumber,
    row: Object.freeze({
      aggregateId,
      shardId,
      sequenceNumber,
      payload: new Uint8Array(payload),
      occurredAt: new Date(Number(millis.value)),
    }),
  });
}

function parseSnapshotRow(
  raw: Record<string, unknown>,
  table: string,
): Result<
  Readonly<{ aggregateId: string; row: SpannerMigrationSnapshotRow }>,
  SpannerMigrationRejection
> {
  const aggregateId = raw.aggregate_id;
  const shard = spannerStoredInteger(
    raw.shard_id,
    "shard_id",
    INT64_MIN,
    INT64_MAX,
  );
  const seq = spannerStoredInteger(
    raw.sequence_number,
    "sequence_number",
    BigInt(0),
    MAX_SEQ_NR,
  );
  const version = spannerStoredInteger(
    raw.version,
    "version",
    INT64_MIN,
    INT64_MAX,
  );
  const payload = raw.payload;
  if (
    typeof aggregateId !== "string" ||
    shard.type === "err" ||
    seq.type === "err" ||
    version.type === "err" ||
    !(payload instanceof Uint8Array)
  ) {
    return Result.err({
      table,
      ...(typeof aggregateId === "string" ? { aggregateId } : {}),
      reason: "invalid snapshot row",
    });
  }
  return Result.ok({
    aggregateId,
    row: Object.freeze({
      shardId: shard.value.toString(),
      sequenceNumber: Number(seq.value),
      version: version.value.toString(),
      payload: new Uint8Array(payload),
    }),
  });
}

type RestoredAggregate<PE> = Readonly<{
  aggregateId: string;
  ok: readonly Readonly<{
    row: SpannerMigrationJournalRow;
    restored: SpannerMigrationRestoredEvent<PE>;
  }>[];
  maxSeqNr: number;
  /** 復元された型名と値が 1 種類だけか。 */
  unique: boolean;
  rejections: readonly SpannerMigrationRejection[];
}>;

type IdentifiedAggregate<PE> = RestoredAggregate<PE> &
  Readonly<{
    id: AggregateId | undefined;
    aidRejection: readonly SpannerMigrationRejection[];
  }>;

type EventsBuilt<PE> = Readonly<{
  a: IdentifiedAggregate<PE>;
  events: readonly EventEnvelope<PE>[] | undefined;
  rejections: readonly SpannerMigrationRejection[];
}>;

const isRestoredEvent = (
  value: unknown,
): value is SpannerMigrationRestoredEvent<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { typeName?: unknown }).typeName === "string" &&
  typeof (value as { value?: unknown }).value === "string";

/** 段階 1: 利用者の復元関数で各行を復元し、集約ごとに型名・値・番号の連続を検査する。 */
function restoreAggregates<PE, PS>(
  byAggregate: ReadonlyMap<string, readonly ParsedJournal[]>,
  input: SpannerMigrationInput<PE, PS>,
  journalTable: string,
): readonly RestoredAggregate<PE>[] {
  return [...byAggregate.entries()].map(([aggregateId, rows]) => {
    const restored = rows.flatMap((p): Restoration<PE>[] => {
      if (p.row === undefined) return [];
      const row = p.row;
      try {
        const result = input.restoreEvent(row);
        if (result.type === "err") {
          return [
            {
              type: "refused",
              row,
              error: `restoreEvent refused: ${result.error}`,
            },
          ];
        }
        // 利用者の関数の返り値は実行時の形を検査する。形が違えば、この行を拒む理由にする。
        const value: unknown = result.type === "ok" ? result.value : undefined;
        if (typeof value !== "object" || value === null) {
          return [
            {
              type: "refused",
              row,
              error: "restoreEvent returned an invalid value",
            },
          ];
        }
        // 各プロパティは 1 回だけ読んで写し取る。以降の段階は写しだけを読み、利用者の getter を再実行しない。
        const copy = {
          typeName: (value as { typeName?: unknown }).typeName,
          value: (value as { value?: unknown }).value,
          manifest: (value as { manifest?: unknown }).manifest,
          payload: (value as { payload?: unknown }).payload,
        };
        if (!isRestoredEvent(copy)) {
          return [
            {
              type: "refused",
              row,
              error: "restoreEvent returned an invalid value",
            },
          ];
        }
        return [
          {
            type: "restored",
            row,
            restored: copy as SpannerMigrationRestoredEvent<PE>,
          },
        ];
      } catch (cause) {
        return [
          {
            type: "refused",
            row,
            error: `restoreEvent threw: ${reasonOf(cause)}`,
          },
        ];
      }
    });
    const restoreRejections = restored.flatMap((r) =>
      r.type === "refused"
        ? [
            {
              table: journalTable,
              aggregateId,
              shardId: r.row.shardId,
              sequenceNumber: r.row.sequenceNumber,
              reason: r.error,
            },
          ]
        : [],
    );
    const ok = restored.flatMap((r) =>
      r.type === "restored" ? [{ row: r.row, restored: r.restored }] : [],
    );

    // 全 shard を合わせて、復元された型名と値が 1 種類だけであること。
    const kinds = new Set(
      ok.map(({ restored: e }) => JSON.stringify([e.typeName, e.value])),
    );
    const kindRejections =
      kinds.size > 1
        ? ok.map(({ row }) => ({
            table: journalTable,
            aggregateId,
            shardId: row.shardId,
            sequenceNumber: row.sequenceNumber,
            reason: "rows restore to different type names or values",
          }))
        : [];

    // seq が 1 から最大値まで欠けず、重複しないこと。
    const seqs = rows.flatMap((p) => (p.seq === undefined ? [] : [p.seq]));
    const maxSeqNr = seqs.reduce((a, b) => Math.max(a, b), 0);
    const seqCounts = new Map<number, number>();
    for (const seq of seqs) seqCounts.set(seq, (seqCounts.get(seq) ?? 0) + 1);
    const duplicateRejections = rows.flatMap((p) =>
      p.seq !== undefined && (seqCounts.get(p.seq) ?? 0) > 1
        ? [
            {
              table: journalTable,
              aggregateId,
              shardId: p.shardId,
              sequenceNumber: p.seq,
              reason: "duplicate sequence_number",
            },
          ]
        : [],
    );
    // 欠番は連続した範囲ごとに 1 件で報告する。件数は行数で抑えられ、最大値の大きさに依存しない。
    const gapRejections = [...seqCounts.keys()]
      .sort((x, y) => x - y)
      .flatMap((seq, i, distinct) => {
        const previous = i === 0 ? 0 : (distinct[i - 1] ?? 0);
        return seq - previous > 1
          ? [
              {
                table: journalTable,
                aggregateId,
                sequenceNumber: previous + 1,
                reason: `missing sequence_number ${previous + 1} to ${seq - 1}`,
              },
            ]
          : [];
      });

    return {
      aggregateId,
      ok,
      maxSeqNr,
      unique: kinds.size === 1,
      rejections: [
        ...restoreRejections,
        ...kindRejections,
        ...duplicateRejections,
        ...gapRejections,
      ],
    };
  });
}

/** 段階 2: 対応表で型名を置き換えて新しい aid を導き、別の aggregate_id との衝突を検出する。 */
function assignAggregateIds<PE, PS>(
  aggregates: readonly RestoredAggregate<PE>[],
  input: SpannerMigrationInput<PE, PS>,
  journalTable: string,
): Readonly<{
  withIds: readonly IdentifiedAggregate<PE>[];
  collisionRejections: readonly SpannerMigrationRejection[];
}> {
  const withIds = aggregates.map((a): IdentifiedAggregate<PE> => {
    const first = a.unique ? a.ok[0]?.restored : undefined;
    if (first === undefined) return { ...a, id: undefined, aidRejection: [] };
    const fail = (reason: string): IdentifiedAggregate<PE> => ({
      ...a,
      id: undefined,
      aidRejection: [
        { table: journalTable, aggregateId: a.aggregateId, reason },
      ],
    });
    let mapped: unknown;
    try {
      mapped = first.typeName.includes("-")
        ? input.typeNameMapping?.get(first.typeName)
        : first.typeName;
    } catch (cause) {
      return fail(`typeNameMapping.get threw: ${reasonOf(cause)}`);
    }
    if (mapped === undefined) {
      return fail(
        `type name "${first.typeName}" contains '-' and has no mapping entry`,
      );
    }
    if (typeof mapped !== "string") {
      return fail(
        `mapping entry for type name "${first.typeName}" is not a string`,
      );
    }
    if (mapped.includes("-")) {
      return fail(`mapped type name "${mapped}" still contains '-'`);
    }
    const id = AggregateId.of(mapped, first.value);
    if (id.type === "err") return fail(id.error.message);
    return { ...a, id: id.value, aidRejection: [] };
  });
  const byAid = group(
    withIds.flatMap((a) =>
      a.id === undefined ? [] : [{ aid: `${a.id.typeName}-${a.id.value}`, a }],
    ),
    (x) => x.aid,
  );
  const collisionRejections = [...byAid.values()]
    .filter((members) => members.length > 1)
    .flatMap((members) =>
      members.map(({ aid, a }) => ({
        table: journalTable,
        aggregateId: a.aggregateId,
        reason: `new aggregate id "${aid}" collides with another aggregate_id`,
      })),
    );
  return { withIds, collisionRejections };
}

/** 段階 3: 拒む理由のない集約について、封筒を作り、移行先のシリアライザで直列化を試す。 */
function buildEvents<PE>(
  withIds: readonly IdentifiedAggregate<PE>[],
  collidingIds: ReadonlySet<string>,
  serializer: PayloadSerializer<PE>,
  journalTable: string,
): readonly EventsBuilt<PE>[] {
  return withIds.map((a): EventsBuilt<PE> => {
    const clean =
      a.rejections.length === 0 &&
      a.aidRejection.length === 0 &&
      !collidingIds.has(a.aggregateId) &&
      a.id !== undefined;
    if (!clean || a.id === undefined)
      return { a, events: undefined, rejections: [] };
    const id = a.id;
    const built = [...a.ok]
      .sort((x, y) => x.row.sequenceNumber - y.row.sequenceNumber)
      .map(({ row, restored }) => {
        const reject = (reason: string) => ({
          table: journalTable,
          aggregateId: a.aggregateId,
          shardId: row.shardId,
          sequenceNumber: row.sequenceNumber,
          reason,
        });
        const envelope = EventEnvelope.create<PE>({
          aggregateId: id,
          seqNr: row.sequenceNumber,
          occurredAt: row.occurredAt,
          manifest: restored.manifest,
          payload: restored.payload,
        });
        if (envelope.type === "err")
          return Result.err(reject(envelope.error.message));
        try {
          serializer.serialize(envelope.value.payload);
        } catch (cause) {
          return Result.err(
            reject(`payload could not be serialized: ${reasonOf(cause)}`),
          );
        }
        return Result.ok(envelope.value);
      });
    return {
      a,
      events: built.flatMap((b) => (b.type === "ok" ? [b.value] : [])),
      rejections: built.flatMap((b) => (b.type === "err" ? [b.error] : [])),
    };
  });
}

type SnapshotPlanned<PE, PS> = EventsBuilt<PE> &
  Readonly<{
    snapshot: SnapshotEnvelope<PS> | undefined;
    snapshotRejections: readonly SpannerMigrationRejection[];
  }>;

/** 段階 4: snapshot の行を集約ごとに束ね、利用者の関数で移すスナップショットを決めて検査する。 */
function planSnapshots<PE, PS>(
  candidates: readonly EventsBuilt<PE>[],
  snapshotRows: readonly Record<string, unknown>[],
  journalAggregateIds: ReadonlySet<string>,
  input: SpannerMigrationInput<PE, PS>,
  serializer: PayloadSerializer<PS>,
): Readonly<{
  withSnapshots: readonly SnapshotPlanned<PE, PS>[];
  snapshotRowRejections: readonly SpannerMigrationRejection[];
  orphanRejections: readonly SpannerMigrationRejection[];
}> {
  const snapshotTable = input.v4Tables.snapshot;
  const snapshotParsed = snapshotRows.map((raw) =>
    parseSnapshotRow(raw, snapshotTable),
  );
  const snapshotRowRejections = snapshotParsed.flatMap((p) =>
    p.type === "err" ? [p.error] : [],
  );
  const snapshotsByAggregate = group(
    snapshotParsed.flatMap((p) => (p.type === "ok" ? [p.value] : [])),
    (s) => s.aggregateId,
  );
  const orphanRejections = [...snapshotsByAggregate.keys()]
    .filter((aggregateId) => !journalAggregateIds.has(aggregateId))
    .map((aggregateId) => ({
      table: snapshotTable,
      aggregateId,
      reason: "snapshot rows have no corresponding journal rows",
    }));

  const withSnapshots = candidates.map((c): SnapshotPlanned<PE, PS> => {
    const rows = snapshotsByAggregate.get(c.a.aggregateId);
    if (rows === undefined || input.restoreSnapshot === undefined) {
      return { ...c, snapshot: undefined, snapshotRejections: [] };
    }
    const reject = (reason: string) => ({
      table: snapshotTable,
      aggregateId: c.a.aggregateId,
      reason,
    });
    const refused = (reason: string): SnapshotPlanned<PE, PS> => ({
      ...c,
      snapshot: undefined,
      snapshotRejections: [reject(reason)],
    });
    let returned: SnapshotEnvelope<PS> | undefined;
    try {
      returned = input.restoreSnapshot(
        Object.freeze({
          aggregateId: c.a.aggregateId,
          maxSeqNr: c.a.maxSeqNr,
          latest: rows
            .filter((r) => r.row.sequenceNumber === 0)
            .map((r) => r.row),
          retained: rows
            .filter((r) => r.row.sequenceNumber > 0)
            .map((r) => r.row),
        }),
      );
    } catch (cause) {
      return refused(`restoreSnapshot threw: ${reasonOf(cause)}`);
    }
    if (returned === undefined) {
      return { ...c, snapshot: undefined, snapshotRejections: [] };
    }
    // 利用者の関数の返り値は実行時の形を検査し、読み取りで例外が出ればこの集約を拒む理由にする。
    if (returned === null || typeof returned !== "object") {
      return refused("restoreSnapshot returned an invalid value");
    }
    let envelope: ReturnType<typeof SnapshotEnvelope.create<PS>>;
    try {
      const seqNr = (returned as { seqNr?: unknown }).seqNr;
      if (typeof seqNr === "number" && seqNr > c.a.maxSeqNr) {
        return refused(
          `snapshot seqNr ${seqNr} exceeds the aggregate maximum ${c.a.maxSeqNr}`,
        );
      }
      if (typeof seqNr === "number" && seqNr < 1) {
        return refused(`snapshot seqNr ${seqNr} has no corresponding event`);
      }
      envelope = SnapshotEnvelope.create<PS>(returned);
    } catch (cause) {
      return refused(
        `restoreSnapshot returned a value that could not be read: ${reasonOf(cause)}`,
      );
    }
    if (envelope.type === "err") return refused(envelope.error.message);
    try {
      serializer.serialize(envelope.value.aggregate);
    } catch (cause) {
      return refused(`snapshot could not be serialized: ${reasonOf(cause)}`);
    }
    return { ...c, snapshot: envelope.value, snapshotRejections: [] };
  });
  return { withSnapshots, snapshotRowRejections, orphanRejections };
}

/**
 * 読み終えた v4 のデータを全件検査して、書き込みの計画を作る。入出力は持たない。
 * 拒む理由は、見つかった全件を返す（最初の 1 件で打ち切らない）。
 */
export function planSpannerMigration<PE, PS>(
  source: SpannerMigrationSource,
  input: SpannerMigrationInput<PE, PS>,
  serializers: Serializers<PE, PS>,
): Result<SpannerMigrationPlan<PE, PS>, readonly SpannerMigrationRejection[]> {
  const journalTable = input.v4Tables.journal;

  const parsed = source.journal.map((raw) =>
    parseJournalRow(raw, journalTable),
  );
  const rowRejections = parsed.flatMap((p) =>
    p.type === "err" ? [p.error] : [],
  );
  const journalRows = parsed.flatMap((p) => (p.type === "ok" ? [p.value] : []));
  const byAggregate = group(journalRows, (r) => r.aggregateId);

  const aggregates = restoreAggregates(byAggregate, input, journalTable);
  const { withIds, collisionRejections } = assignAggregateIds(
    aggregates,
    input,
    journalTable,
  );
  const collidingIds = new Set(
    collisionRejections.flatMap((r) =>
      r.aggregateId === undefined ? [] : [r.aggregateId],
    ),
  );
  const candidates = buildEvents(
    withIds,
    collidingIds,
    serializers.eventSerializer,
    journalTable,
  );
  const { withSnapshots, snapshotRowRejections, orphanRejections } =
    planSnapshots(
      candidates,
      source.snapshots,
      new Set(byAggregate.keys()),
      input,
      serializers.snapshotSerializer,
    );

  const rejections: readonly SpannerMigrationRejection[] = [
    ...rowRejections,
    ...withIds.flatMap((a) => [...a.rejections, ...a.aidRejection]),
    ...collisionRejections,
    ...withSnapshots.flatMap((c) => c.rejections),
    ...snapshotRowRejections,
    ...orphanRejections,
    ...withSnapshots.flatMap((c) => c.snapshotRejections),
  ];
  if (rejections.length > 0) return Result.err(rejections);

  return Result.ok(
    withSnapshots
      .flatMap((c) =>
        c.events === undefined || c.a.id === undefined
          ? []
          : [
              {
                v4AggregateId: c.a.aggregateId,
                id: c.a.id,
                events: c.events,
                snapshot: c.snapshot,
              },
            ],
      )
      .sort((x, y) => {
        const a = `${x.id.typeName}-${x.id.value}`;
        const b = `${y.id.typeName}-${y.id.value}`;
        return a < b ? -1 : a > b ? 1 : 0;
      }),
  );
}
