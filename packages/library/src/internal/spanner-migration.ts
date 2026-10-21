import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SpannerEventStoreInput } from "../spanner-event-store-input";
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
  cause?: unknown,
): Result<never, SpannerMigrationFailure> =>
  Result.err({
    type: "error",
    error: EventStoreError.configuration(fieldName, message, cause),
    progress: NO_PROGRESS,
  });

type ReadInput<PE, PS> = Readonly<{
  /** 検査後の、凍結した写し。以降の処理は入力そのものではなくこれを読む。 */
  input: SpannerMigrationInput<PE, PS>;
  targetInput: SpannerEventStoreInput<PE, PS>;
}>;

/** 入力の最上位の項目を 1 回だけ読んで検査する。読み取りの例外は設定エラーにする。 */
function readMigrationInput<PE, PS>(
  raw: SpannerMigrationInput<PE, PS>,
): Result<ReadInput<PE, PS>, SpannerMigrationFailure> {
  let fieldName = "input";
  try {
    if (raw === null || typeof raw !== "object") {
      return configurationFailure("input", "input must be an object");
    }
    fieldName = "database";
    const database = raw.database;
    fieldName = "v4Tables";
    const v4Tables = raw.v4Tables;
    fieldName = "target";
    const target = raw.target;
    fieldName = "typeNameMapping";
    const typeNameMapping = raw.typeNameMapping;
    fieldName = "restoreEvent";
    const restoreEvent = raw.restoreEvent;
    fieldName = "restoreSnapshot";
    const restoreSnapshot = raw.restoreSnapshot;
    if (typeof restoreEvent !== "function") {
      return configurationFailure(
        "restoreEvent",
        "restoreEvent must be a function",
      );
    }
    if (
      restoreSnapshot !== undefined &&
      typeof restoreSnapshot !== "function"
    ) {
      return configurationFailure(
        "restoreSnapshot",
        "restoreSnapshot must be a function",
      );
    }
    fieldName = "typeNameMapping";
    if (
      typeNameMapping !== undefined &&
      (typeNameMapping === null || typeof typeNameMapping.get !== "function")
    ) {
      return configurationFailure(
        "typeNameMapping",
        "typeNameMapping must have a get function",
      );
    }
    fieldName = "v4Tables";
    const invalidV4Tables = configurationFailure(
      "v4Tables",
      "v4Tables.journal and v4Tables.snapshot must be SQL identifiers of at most 128 characters",
    );
    if (v4Tables === null || typeof v4Tables !== "object") {
      return invalidV4Tables;
    }
    const journal = v4Tables.journal;
    const snapshot = v4Tables.snapshot;
    if (!isSpannerIdentifier(journal) || !isSpannerIdentifier(snapshot)) {
      return invalidV4Tables;
    }
    fieldName = "target";
    const targetInput = Object.freeze({ ...target, database });
    return Result.ok({
      input: Object.freeze({
        database,
        v4Tables: Object.freeze({ journal, snapshot }),
        target,
        typeNameMapping,
        restoreEvent,
        restoreSnapshot,
      }),
      targetInput,
    });
  } catch (cause) {
    return configurationFailure(
      fieldName,
      "migration input could not be read",
      cause,
    );
  }
}

/**
 * v4 の journal / snapshot を v5 の 5 テーブルへ移す。
 * 読み取り（v4 の全件と移行先の状態）→ 全件検査 → 書き込み → 読み戻しの照合の順に進む。
 * 検査で拒む理由が 1 つでもあれば、移行先に何も書かない。
 */
export async function migrateV4SpannerInternal<PE, PS>(
  rawInput: SpannerMigrationInput<PE, PS>,
): Promise<Result<SpannerMigrationReport, SpannerMigrationFailure>> {
  const read = readMigrationInput(rawInput);
  if (read.type === "err") return read;
  const { input, targetInput } = read.value;
  const { database, v4Tables } = input;

  const settings = validateSpannerEventStoreInput<PE, PS>(targetInput);
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
  const opened = await initializeSpannerEventStoreInternal<PE, PS>(targetInput);
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

  const source = await readSpannerMigrationSource(database, v4Tables, [
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
