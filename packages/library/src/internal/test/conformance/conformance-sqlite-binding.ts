import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SqliteEventStore } from "../../../sqlite-event-store";
import { SqliteEventStore as SqliteEventStoreFactory } from "../../../sqlite-event-store";
import type { SqliteEventStoreInput } from "../../../sqlite-event-store-input";
import { openSqliteEventStoreInternal } from "../../sqlite-event-store";
import type { SqliteEventStoreHooks } from "../../sqlite-event-store-hooks";
import {
  readSqliteRows,
  type SqliteConfigRow,
  sqliteTempDirectory,
  writeSqliteFile,
} from "../sqlite-fixture";
import type { ConformanceCreatedStore } from "./conformance-created-store";
import { ConformanceFaultRegistry } from "./conformance-fault-registry";
import { listOf, recordOf } from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";
import type { ConformanceOutcome } from "./conformance-outcome";
import { ConformancePublicBinding } from "./conformance-public-binding";
import type { ConformanceStore } from "./conformance-store";
import type { ConformanceStoreCreation } from "./conformance-store-creation";

/** ケースごとに一時ファイルを作り、`dispose` で閉じて削除する。実サービスには接続しない。 */
export class ConformanceSqliteBinding extends ConformancePublicBinding {
  readonly backend = "sqlite";

  async createStore(
    creation: ConformanceStoreCreation,
  ): Promise<ConformanceCreatedStore<unknown, unknown>> {
    const { config } = creation;
    const registry = new ConformanceFaultRegistry(creation.faults);
    const temp = sqliteTempDirectory();
    let notifications: string[] = [];
    let files: ReadonlyMap<string, string> = new Map([
      ["primary", temp.file("primary.sqlite3")],
    ]);
    let counter = 0;
    const stores: SqliteEventStore[] = [];
    let lockHolder: DatabaseSync | undefined;

    const fail = (phase: string) => {
      const fault = registry.take(phase);
      if (fault === undefined) return;
      assert.equal(fault.declaration.injection, "replace-request");
      assert.equal(fault.declaration.kind, "storage-error");
      registry.applied(fault.index);
      throw new Error(String(recordOf(fault.declaration.details).message));
    };
    const hooks: SqliteEventStoreHooks = {
      beforeCommit: () => fail("commit"),
      afterReadHead: (read) =>
        fail(read === "events" ? "read-events" : "read-snapshot"),
      beforeRetentionDelete: () => fail("retention-delete"),
      listHistory: (_aid, seqNrs) => {
        const fault = registry.take("retention-query");
        if (fault === undefined) return seqNrs;
        if (fault.declaration.kind === "storage-error") {
          registry.applied(fault.index);
          throw new Error(String(recordOf(fault.declaration.details).message));
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
    };

    const inputOf = (
      file: string,
    ): SqliteEventStoreInput<ConformanceJsonValue, ConformanceJsonValue> => ({
      path: file,
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
                      type: "ttl" as const,
                      graceSeconds: config.ttlGraceSeconds as number,
                    }
                  : { type: "delete" as const },
            },
          }),
      ...(config.changeFeed === true ? { changeFeed: true } : {}),
      ...(config.lockWaitMilliseconds === undefined
        ? {}
        : { lockWaitMilliseconds: config.lockWaitMilliseconds }),
      onRetentionFailure: (failure) => {
        notifications = [...notifications, failure.kind];
      },
      logger: { ...console, error: () => undefined },
    });

    // 保存先の初期化は、生成とは別の手順で行う（SQ-D6）。シードがあればそのまま書く。
    const prepare = async (
      file: string,
    ): Promise<ConformanceOutcome<never> | undefined> => {
      if (creation.seedConfiguration !== undefined) {
        writeSqliteFile(file, {
          config: creation.seedConfiguration as unknown as SqliteConfigRow,
        });
        return undefined;
      }
      const initialized = await SqliteEventStoreFactory.initialize(
        inputOf(file),
      );
      return initialized.type === "err"
        ? this.outcome<never>(initialized)
        : undefined;
    };
    const open = async (
      file: string,
    ): Promise<ConformanceOutcome<ConformanceStore<unknown, unknown>>> => {
      const opened = await openSqliteEventStoreInternal<
        ConformanceJsonValue,
        ConformanceJsonValue
      >(inputOf(file), hooks);
      if (opened.type === "err") return this.outcome<never>(opened);
      stores.push(opened.value);
      return { kind: "ok" as const, value: this.wrapStore(opened.value) };
    };

    const primary = files.get("primary") as string;
    const outcome = (await prepare(primary)) ?? (await open(primary));

    const readHistory = async (id: { typeName: string; value: string }) => ({
      active: readSqliteRows(
        primary,
        "SELECT seq_nr FROM snapshot_history WHERE aid = ? ORDER BY seq_nr",
        `${id.typeName}-${id.value}`,
      ).map((row) => row.seq_nr as bigint),
      marked: [],
    });

    return {
      outcome,
      hooks: {
        createStore: async (request) => {
          let target: string | undefined;
          if (request.storage === "new") {
            counter += 1;
            target = temp.file(`store-${counter}.sqlite3`);
            const failed = await prepare(target);
            if (failed !== undefined) return failed;
          } else {
            target = files.get(request.sharedWith ?? "");
          }
          assert.ok(target, "shared_with store must be registered");
          const created = await open(target);
          if (created.kind === "ok")
            files = new Map([...files, [request.name, target]]);
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
        holdWriteLock: async () => {
          assert.equal(lockHolder, undefined, "write lock is already held");
          const holder = new DatabaseSync(primary);
          holder.exec("PRAGMA busy_timeout = 0");
          holder.exec("BEGIN IMMEDIATE");
          lockHolder = holder;
        },
        releaseWriteLock: async () => {
          assert.ok(lockHolder, "write lock must be held");
          lockHolder.exec("ROLLBACK");
          lockHolder.close();
          lockHolder = undefined;
        },
        readHistory,
        evidence: () => ({ faults: registry.snapshot() }),
      },
      dispose: async () => {
        if (lockHolder !== undefined) {
          lockHolder.close();
          lockHolder = undefined;
        }
        for (const store of stores) store.close();
        temp.remove();
      },
    };
  }
}
