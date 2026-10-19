import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Snapshot } from "@google-cloud/spanner";
import { SpannerEventStore } from "../../../spanner-event-store";
import type { SpannerEventStoreInput } from "../../../spanner-event-store-input";
import { fnv1a64 } from "../../fnv1a64";
import { spannerAggregateKey } from "../../spanner-aggregate-key";
import * as spannerFactory from "../../spanner-event-store";
import { spannerRows } from "../../spanner-rows";
import { spannerTableNames } from "../../spanner-table-names";
import type {
  SpannerEmulator,
  SpannerSeedConfiguration,
  SpannerStoreSetup,
} from "../spanner-emulator";
import type { ConformanceCreatedStore } from "./conformance-created-store";
import { ConformanceFaultRegistry } from "./conformance-fault-registry";
import { listOf, recordOf } from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";
import type { ConformanceOutcome } from "./conformance-outcome";
import { ConformancePublicBinding } from "./conformance-public-binding";
import type { ConformanceStore } from "./conformance-store";
import type { ConformanceStoreCreation } from "./conformance-store-creation";

const SECONDS_PER_DAY = 86400;

export class ConformanceSpannerBinding extends ConformancePublicBinding {
  readonly backend = "spanner";

  constructor(private readonly emulator: SpannerEmulator) {
    super();
  }

  fnv1a64(utf8: string): bigint {
    return fnv1a64(utf8);
  }

  private setupOf(creation: ConformanceStoreCreation): SpannerStoreSetup {
    const { config } = creation;
    const grace = config.ttlGraceDays;
    // 猶予が正でなければ行削除ポリシーを作らない（クライアント側の検査で生成が失敗する場面）
    const defaultPolicyDays =
      config.retentionMode === "ttl" &&
      typeof grace === "number" &&
      Number.isSafeInteger(grace) &&
      grace > 0
        ? grace
        : null;
    return {
      rowDeletionPolicyDays:
        creation.rowDeletionPolicyDays === undefined
          ? defaultPolicyDays
          : creation.rowDeletionPolicyDays,
      configuration:
        creation.seedConfiguration === undefined
          ? {
              store_id: randomUUID(),
              layout_version: 1,
              keep_snapshot_count: config.retentionCount,
              retention_mode: config.retentionMode,
              ttl_grace_days:
                config.retentionMode === "ttl" ? (grace ?? null) : null,
              change_feed_enabled: false,
            }
          : (creation.seedConfiguration as unknown as SpannerSeedConfiguration),
    };
  }

  async createStore(
    creation: ConformanceStoreCreation,
  ): Promise<ConformanceCreatedStore<unknown, unknown>> {
    const { config } = creation;
    const registry = new ConformanceFaultRegistry(creation.faults);
    let notifications: string[] = [];
    const prefix = await this.emulator.createStore(this.setupOf(creation));
    let prefixes: ReadonlyMap<string, string> = new Map([["primary", prefix]]);

    const fail = (phase: string) => {
      const fault = registry.take(phase);
      if (fault === undefined) return;
      assert.equal(fault.declaration.injection, "replace-request");
      assert.equal(fault.declaration.kind, "storage-error");
      registry.applied(fault.index);
      throw new Error(String(recordOf(fault.declaration.details).message));
    };
    const original = spannerFactory.initializeSpannerEventStoreInternal;
    const wrapper = jest
      .spyOn(spannerFactory, "initializeSpannerEventStoreInternal")
      .mockImplementation(<PE, PS>(input: SpannerEventStoreInput<PE, PS>) =>
        original(input, {
          // 中断は、エミュレーターに 2 つ目のトランザクションを重ねず、ライブラリの中のフックで返す。
          beforeCommit: () => {
            const fault = registry.take("commit", "replace-request");
            if (fault === undefined) return;
            registry.applied(fault.index);
            if (fault.declaration.kind === "transaction-aborted")
              throw Object.assign(new Error("transaction aborted"), {
                code: 10,
              });
            assert.equal(fault.declaration.kind, "storage-error");
            throw new Error(
              String(recordOf(fault.declaration.details).message),
            );
          },
          afterCommit: () => {
            const fault = registry.take("commit", "replace-response");
            if (fault === undefined) return;
            assert.equal(fault.declaration.kind, "storage-error");
            registry.applied(fault.index);
            throw new Error(
              String(recordOf(fault.declaration.details).message),
            );
          },
          beforeReadEvents: () => fail("read-events"),
          beforeReadSnapshot: () => fail("read-snapshot"),
          beforeRetentionDelete: () => fail("retention-delete"),
          listHistory: (_aid, seqNrs) => {
            const fault = registry.take("retention-query");
            if (fault === undefined) return seqNrs;
            if (fault.declaration.kind === "storage-error") {
              registry.applied(fault.index);
              throw new Error(
                String(recordOf(fault.declaration.details).message),
              );
            }
            assert.equal(fault.declaration.kind, "sdk-response");
            assert.equal(fault.declaration.injection, "replace-response");
            const listed = listOf(
              recordOf(fault.declaration.details).history_pages,
            ).flatMap((page) => listOf(page).map(Number));
            assert.ok(
              listed.every((n) => seqNrs.includes(n)),
              "history plan must use stored history",
            );
            registry.applied(fault.index);
            return listed;
          },
        }),
      );

    const open = async (
      tablePrefix: string,
    ): Promise<ConformanceOutcome<ConformanceStore<unknown, unknown>>> => {
      try {
        const opened = await SpannerEventStore.create<
          ConformanceJsonValue,
          ConformanceJsonValue
        >({
          database: this.emulator.database,
          tablePrefix,
          eventSerializer: this.serializer(registry, "event"),
          snapshotSerializer: this.serializer(registry, "snapshot"),
          ...(config.retentionCount === null
            ? {}
            : {
                retention: {
                  count: config.retentionCount,
                  mode:
                    config.retentionMode === "ttl"
                      ? {
                          type: "ttl",
                          graceDays: config.ttlGraceDays as number,
                        }
                      : "delete",
                },
              }),
          ...(config.changeFeed === true ? { changeFeed: true } : {}),
          ...(config.transactionRetryLimit === undefined
            ? {}
            : { transactionRetryLimit: config.transactionRetryLimit }),
          onRetentionFailure: (failure) => {
            notifications = [...notifications, failure.kind];
          },
          logger: { ...console, error: () => undefined },
        });
        return opened.type === "err"
          ? this.outcome<never>(opened)
          : { kind: "ok" as const, value: this.wrapStore(opened.value) };
      } finally {
        wrapper.mockRestore();
      }
    };
    const outcome = await open(prefix);

    const readHistory = async (id: { typeName: string; value: string }) => {
      const tables = spannerTableNames(prefix);
      assert.ok(tables.type === "ok", "prefix must form table names");
      const { hashPrefix, aid } = spannerAggregateKey(id);
      const [snapshot] = await this.emulator.database.getSnapshot({
        strong: true,
      });
      try {
        const rows = await spannerRows(
          snapshot as Snapshot,
          `SELECT seq_nr, expired_at IS NULL AS active, UNIX_SECONDS(expired_at) AS expired_seconds FROM \`${tables.value.snapshotHistory}\` WHERE hash_prefix = @hp AND aid = @aid ORDER BY seq_nr`,
          { hp: hashPrefix, aid },
          { hp: "bytes", aid: "string" },
        );
        const seqNrOf = (row: Record<string, unknown>) =>
          BigInt((row.seq_nr as { value: string }).value);
        return {
          active: rows.filter((row) => row.active === true).map(seqNrOf),
          marked: rows
            .filter((row) => row.active !== true)
            .map((row) => ({
              seqNr: seqNrOf(row),
              expires:
                Number((row.expired_seconds as { value: string }).value) +
                (config.ttlGraceDays ?? 0) * SECONDS_PER_DAY,
            })),
        };
      } finally {
        snapshot.end();
      }
    };

    return {
      outcome,
      hooks: {
        createStore: async (request) => {
          const target =
            request.storage === "new"
              ? await this.emulator.createStore(this.setupOf(creation))
              : prefixes.get(request.sharedWith ?? "");
          assert.ok(target, "shared_with store must be registered");
          const created = await open(target);
          if (created.kind === "ok")
            prefixes = new Map([...prefixes, [request.name, target]]);
          return created;
        },
        beginOperation: (operation: number) => {
          registry.begin(operation);
        },
        finishOperation: (operation: number) => registry.finish(operation),
        takeRetentionFailures: () => {
          const taken = notifications;
          notifications = [];
          return taken;
        },
        readHistory,
        evidence: () => ({ faults: registry.snapshot() }),
      },
      dispose: async () => undefined,
    };
  }
}
