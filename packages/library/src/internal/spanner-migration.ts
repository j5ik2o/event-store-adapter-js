import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SpannerMigrationFailure } from "../spanner-migration-failure";
import type { SpannerMigrationInput } from "../spanner-migration-input";
import type { SpannerMigrationRejection } from "../spanner-migration-rejection";
import type { SpannerMigrationReport } from "../spanner-migration-report";
import { initializeSpannerEventStoreInternal } from "./spanner-event-store";
import { validateSpannerEventStoreInput } from "./spanner-event-store-input-validation";
import { planSpannerMigration } from "./spanner-migration-plan";
import { readSpannerMigrationSource } from "./spanner-migration-read";
import {
  verifySpannerMigration,
  writeSpannerMigration,
} from "./spanner-migration-write";
import { isSpannerIdentifier } from "./spanner-table-names";

const NO_PROGRESS = { aggregates: 0, events: 0, snapshots: 0 };

const configurationFailure = (
  fieldName: string,
  message: string,
): Result<never, SpannerMigrationFailure> =>
  Result.err({
    type: "error",
    error: EventStoreError.configuration(fieldName, message),
    progress: NO_PROGRESS,
  });

/**
 * v4 の journal / snapshot を v5 の 5 テーブルへ移す。
 * 読み取り（v4 の全件と移行先の状態）→ 全件検査 → 書き込み → 読み戻しの照合の順に進む。
 * 検査で拒む理由が 1 つでもあれば、移行先に何も書かない。
 */
export async function migrateV4SpannerInternal<PE, PS>(
  input: SpannerMigrationInput<PE, PS>,
): Promise<Result<SpannerMigrationReport, SpannerMigrationFailure>> {
  if (input === null || typeof input !== "object") {
    return configurationFailure("input", "input must be an object");
  }
  if (typeof input.restoreEvent !== "function") {
    return configurationFailure(
      "restoreEvent",
      "restoreEvent must be a function",
    );
  }
  if (
    input.restoreSnapshot !== undefined &&
    typeof input.restoreSnapshot !== "function"
  ) {
    return configurationFailure(
      "restoreSnapshot",
      "restoreSnapshot must be a function",
    );
  }
  if (
    input.typeNameMapping !== undefined &&
    (input.typeNameMapping === null ||
      typeof input.typeNameMapping.get !== "function")
  ) {
    return configurationFailure(
      "typeNameMapping",
      "typeNameMapping must have a get function",
    );
  }
  const v4Tables = input.v4Tables;
  if (
    v4Tables === null ||
    typeof v4Tables !== "object" ||
    !isSpannerIdentifier(v4Tables.journal) ||
    !isSpannerIdentifier(v4Tables.snapshot)
  ) {
    return configurationFailure(
      "v4Tables",
      "v4Tables.journal and v4Tables.snapshot must be SQL identifiers of at most 128 characters",
    );
  }

  const settings = validateSpannerEventStoreInput<PE, PS>({
    ...input.target,
    database: input.database,
  });
  if (settings.type === "err") {
    return Result.err({
      type: "error",
      error: settings.error,
      progress: NO_PROGRESS,
    });
  }
  const { tables } = settings.value;

  const targetNames = [
    tables.journal,
    tables.head,
    tables.snapshotCurrent,
    tables.snapshotHistory,
    tables.config,
  ];
  const overlaps = [v4Tables.journal, v4Tables.snapshot].filter((name) =>
    targetNames.some((target) => target.toLowerCase() === name.toLowerCase()),
  );
  if (overlaps.length > 0) {
    return Result.err({
      type: "rejected",
      rejections: overlaps.map((table) => ({
        table,
        reason: "v4 table name overlaps a target table",
      })),
    });
  }

  // 移行先を作ったり補ったりしない。初期化されていなければここで拒む。
  const opened = await initializeSpannerEventStoreInternal<PE, PS>({
    ...input.target,
    database: input.database,
  });
  if (opened.type === "err") {
    return opened.error.type === "configuration-error"
      ? Result.err({
          type: "rejected",
          rejections: [{ table: tables.config, reason: opened.error.message }],
        })
      : Result.err({
          type: "error",
          error: opened.error,
          progress: NO_PROGRESS,
        });
  }
  const store = opened.value;

  const source = await readSpannerMigrationSource(input.database, v4Tables, [
    tables.journal,
    tables.head,
    tables.snapshotCurrent,
    tables.snapshotHistory,
  ]);
  if (source.type === "err") {
    return Result.err({
      type: "error",
      error: source.error,
      progress: NO_PROGRESS,
    });
  }

  const targetRejections: readonly SpannerMigrationRejection[] =
    source.value.populatedTargetTables.map((table) => ({
      table,
      reason: "target table already has rows",
    }));
  const planned = planSpannerMigration(source.value, input, {
    eventSerializer: settings.value.eventSerializer,
    snapshotSerializer: settings.value.snapshotSerializer,
  });
  const rejections = [
    ...targetRejections,
    ...(planned.type === "err" ? planned.error : []),
  ];
  if (planned.type === "err" || rejections.length > 0) {
    return Result.err({ type: "rejected", rejections });
  }
  const plan = planned.value;

  const written = await writeSpannerMigration(store, plan);
  if (written.type === "err") {
    return Result.err({ type: "error", ...written.error });
  }
  const verified = await verifySpannerMigration(store, plan);
  if (verified.type === "err") {
    return Result.err({
      type: "error",
      error: verified.error,
      progress: written.value,
    });
  }
  if (verified.value.length > 0) {
    return Result.err({
      type: "verification-failed",
      mismatches: verified.value,
      progress: written.value,
    });
  }
  return Result.ok(
    Object.freeze({
      ...written.value,
      eventsOnlyAggregates: plan
        .filter((aggregate) => aggregate.snapshot === undefined)
        .map((aggregate) => aggregate.v4AggregateId),
    }),
  );
}
