import type { EventStore } from "../event-store";
import type { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SpannerMigrationReport } from "../spanner-migration-report";
import type { SpannerMigrationPlan } from "./spanner-migration-plan";

type Counts = Pick<
  SpannerMigrationReport,
  "aggregates" | "events" | "snapshots"
>;

export type SpannerMigrationWriteFailure = Readonly<{
  error: EventStoreError;
  /** 書き終えた件数。集約は全イベントを書き終えたものだけを数える。 */
  progress: Counts;
}>;

/**
 * 計画を新しい aid の昇順に、集約ごと seq_nr の順に v5 の公開 API で書く。
 * スナップショットは、同じ seq_nr のイベントと一緒に書く。
 * 件数はここ 1 か所で数える。
 */
export async function writeSpannerMigration<PE, PS>(
  store: EventStore<PE, PS>,
  plan: SpannerMigrationPlan<PE, PS>,
): Promise<Result<Counts, SpannerMigrationWriteFailure>> {
  // NOTE: 関数の外へ漏らさない進捗の累積。書き込みの途中で失敗したときの件数を返すために更新する。
  let aggregates = 0;
  let events = 0;
  let snapshots = 0;
  for (const aggregate of plan) {
    for (const event of aggregate.events) {
      const snapshot =
        aggregate.snapshot !== undefined &&
        aggregate.snapshot.seqNr === event.seqNr
          ? aggregate.snapshot
          : undefined;
      const written =
        snapshot === undefined
          ? await store.persistEvent(event)
          : await store.persistEventAndSnapshot(event, snapshot);
      if (written.type === "err") {
        return Result.err({
          error: written.error,
          progress: { aggregates, events, snapshots },
        });
      }
      events += 1;
      snapshots += snapshot === undefined ? 0 : 1;
    }
    aggregates += 1;
  }
  return Result.ok({ aggregates, events, snapshots });
}

export type SpannerMigrationMismatch = Readonly<{
  aggregateId: string;
  reason: string;
}>;

/** 書いた後に公開 API で読み戻し、イベントの数と連続、headSeqNr、スナップショットの seq_nr を計画と照合する。 */
export async function verifySpannerMigration<PE, PS>(
  store: EventStore<PE, PS>,
  plan: SpannerMigrationPlan<PE, PS>,
): Promise<Result<readonly SpannerMigrationMismatch[], EventStoreError>> {
  const found: SpannerMigrationMismatch[] = [];
  for (const aggregate of plan) {
    const mismatch = (reason: string) =>
      found.push({ aggregateId: aggregate.v4AggregateId, reason });
    const expected = aggregate.events.length;
    const read = await store.getEventsByIdSinceSeqNr(aggregate.id, 1);
    if (read.type === "err") return read;
    if (read.value.length !== expected) {
      mismatch(`expected ${expected} events but read ${read.value.length}`);
    } else if (read.value.some((event, i) => event.seqNr !== i + 1)) {
      mismatch("read events are not consecutive from 1");
    }
    const latest = await store.getLatestSnapshotById(aggregate.id);
    if (latest.type === "err") return latest;
    if (latest.value?.headSeqNr !== expected) {
      mismatch(
        `expected headSeqNr ${expected} but read ${latest.value?.headSeqNr}`,
      );
    }
    if (latest.value?.snapshot?.seqNr !== aggregate.snapshot?.seqNr) {
      mismatch(
        `expected snapshot seqNr ${aggregate.snapshot?.seqNr} but read ${latest.value?.snapshot?.seqNr}`,
      );
    }
  }
  return Result.ok(found);
}
