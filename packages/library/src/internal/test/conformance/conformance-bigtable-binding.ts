import assert from "node:assert/strict";
import { BigtableEventStore } from "../../../bigtable-event-store";
import type { BigtableEventStoreInput } from "../../../bigtable-event-store-input";
import { EventStoreError } from "../../../event-store-error";
import { Result } from "../../../result";
import {
  decodeEventEnvelope,
  decodeSnapshotEnvelope,
  encodeEventEnvelope,
  encodeSnapshotEnvelope,
} from "../../bigtable-envelope";
import { openBigtableEventStoreInternal } from "../../bigtable-event-store";
import type { BigtableEventStoreHooks } from "../../bigtable-event-store-hooks";
import { readHead } from "../../bigtable-head";
import {
  CONFIG_METADATA,
  chain,
  column,
  FAMILY_CONFIG,
  FAMILY_HISTORY,
  HISTORY_STATE,
  latestCell,
  STATE_ACTIVE,
} from "../../bigtable-request-parts";
import { BigtableTableRequests } from "../../bigtable-requests";
import { cellValue } from "../../bigtable-row";
import {
  aggregatePrefix,
  CONFIG_ROW_KEY,
  journalRange,
} from "../../bigtable-row-keys";
import { fnv1a64 } from "../../fnv1a64";
import { BigtableEmulator, type BigtableTables } from "../bigtable-emulator";
import { configurationJsonOf } from "./conformance-bigtable-configuration";
import type { ConformanceCreatedStore } from "./conformance-created-store";
import { ConformanceFaultRegistry } from "./conformance-fault-registry";
import { listOf, recordOf } from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";
import type { ConformanceOutcome } from "./conformance-outcome";
import { ConformancePublicBinding } from "./conformance-public-binding";
import type { ConformanceStore } from "./conformance-store";
import type { ConformanceStoreCreation } from "./conformance-store-creation";

const fromHex = (hex: string): Uint8Array => Buffer.from(hex, "hex");

/** Bigtable エミュレーターを 1 つ起動し、ケースごとに新しい 2 テーブルを作る。実サービスには接続しない。 */
export class ConformanceBigtableBinding extends ConformancePublicBinding {
  readonly backend = "bigtable";
  private emulator: BigtableEmulator | undefined;

  async start(): Promise<void> {
    this.emulator = await BigtableEmulator.start();
  }

  async stop(): Promise<void> {
    await this.emulator?.stop();
    this.emulator = undefined;
  }

  fnv1a64(utf8: string): bigint {
    return fnv1a64(utf8);
  }

  encodeBigtableEventEnvelope(input: {
    aid: string;
    seqNr: number;
    occurredAtNs: bigint;
    manifest: string;
    payloadHex: string;
  }): ConformanceOutcome<string> {
    return {
      kind: "ok",
      value: Buffer.from(
        encodeEventEnvelope({
          aid: input.aid,
          seqNr: input.seqNr,
          occurredAtNs: input.occurredAtNs,
          manifest: input.manifest,
          payload: fromHex(input.payloadHex),
        }),
      ).toString("hex"),
    };
  }

  encodeBigtableSnapshotEnvelope(input: {
    seqNr: number;
    manifest: string;
    payloadHex: string;
  }): ConformanceOutcome<string> {
    return {
      kind: "ok",
      value: Buffer.from(
        encodeSnapshotEnvelope({
          seqNr: input.seqNr,
          manifest: input.manifest,
          payload: fromHex(input.payloadHex),
        }),
      ).toString("hex"),
    };
  }

  decodeBigtableEnvelope(input: {
    kind: "event" | "snapshot";
    bytesHex: string;
  }): ConformanceOutcome<unknown> {
    try {
      const bytes = fromHex(input.bytesHex);
      return {
        kind: "ok",
        value:
          input.kind === "event"
            ? decodeEventEnvelope(bytes)
            : decodeSnapshotEnvelope(bytes),
      };
    } catch (cause) {
      return this.outcome<never>(
        Result.err(
          cause instanceof Error
            ? EventStoreError.storage("envelope could not be decoded", cause)
            : (cause as EventStoreError),
        ),
      );
    }
  }

  async createStore(
    creation: ConformanceStoreCreation,
  ): Promise<ConformanceCreatedStore<unknown, unknown>> {
    const emulator = this.emulator;
    assert.ok(emulator, "the Bigtable emulator must be started");
    const { config } = creation;
    const registry = new ConformanceFaultRegistry(creation.faults);
    let notifications: string[] = [];
    let named: ReadonlyMap<string, BigtableTables> = new Map();
    let primary: BigtableTables | undefined;

    const fail = (phase: string, injection: string) => {
      const fault = registry.take(phase, injection);
      if (fault === undefined) return;
      assert.equal(fault.declaration.kind, "storage-error");
      registry.applied(fault.index);
      throw new Error(String(recordOf(fault.declaration.details).message));
    };
    const failRead = (phase: string) => {
      const fault = registry.take(phase);
      if (fault === undefined) return;
      assert.equal(fault.declaration.injection, "replace-request");
      assert.equal(fault.declaration.kind, "storage-error");
      registry.applied(fault.index);
      throw new Error(String(recordOf(fault.declaration.details).message));
    };
    const hooks: BigtableEventStoreHooks = {
      // replace-request は要求を送らずに失敗させ、replace-response は送った後に応答を失わせる。
      journalWritePrevious: () =>
        fail("journal-write-previous", "replace-request"),
      beforeCommit: () => fail("commit", "replace-request"),
      afterCommit: () => fail("commit", "replace-response"),
      journalWriteTail: () => fail("journal-write-tail", "replace-request"),
      afterReadHead: (read) =>
        failRead(read === "events" ? "read-events" : "read-snapshot"),
      beforeRetentionDelete: () => failRead("retention-delete"),
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
      tables: BigtableTables,
    ): BigtableEventStoreInput<ConformanceJsonValue, ConformanceJsonValue> => ({
      bigtable: emulator.bigtable,
      instanceId: emulator.instanceId,
      tables,
      eventSerializer: this.serializer(registry, "event"),
      snapshotSerializer: this.serializer(registry, "snapshot"),
      ...(config.envelopeLimitBytes === undefined
        ? {}
        : { envelopeLimitBytes: config.envelopeLimitBytes }),
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
      onRetentionFailure: (failure) => {
        notifications = [...notifications, failure.kind];
      },
      onJournalWriteFailure: (failure) => {
        notifications = [...notifications, failure.kind];
      },
      logger: { ...console, error: () => undefined },
    });

    // 保存先の初期化は、生成とは別の手順で行う（BT-D1）。シードがあれば設定行をそのまま書く。
    const prepare = async (): Promise<
      Readonly<{ tables: BigtableTables }> | ConformanceOutcome<never>
    > => {
      const tables = await emulator.createTables();
      if (creation.seedConfiguration !== undefined) {
        const seed = recordOf(creation.seedConfiguration);
        for (const [table, record] of [
          [tables.journal, seed.journal],
          [tables.head, seed.head],
        ] as const) {
          await emulator.writeCell(
            table,
            CONFIG_ROW_KEY,
            FAMILY_CONFIG,
            CONFIG_METADATA,
            configurationJsonOf(record as ConformanceJsonValue),
          );
        }
        return { tables };
      }
      const initialized = await BigtableEventStore.initialize(inputOf(tables));
      return initialized.type === "err"
        ? this.outcome<never>(initialized)
        : { tables };
    };
    const open = async (
      tables: BigtableTables,
    ): Promise<ConformanceOutcome<ConformanceStore<unknown, unknown>>> => {
      const opened = await openBigtableEventStoreInternal<
        ConformanceJsonValue,
        ConformanceJsonValue
      >(inputOf(tables), hooks);
      if (opened.type === "err") return this.outcome<never>(opened);
      return { kind: "ok" as const, value: this.wrapStore(opened.value) };
    };
    const isOutcome = (
      value: Readonly<{ tables: BigtableTables }> | ConformanceOutcome<never>,
    ): value is ConformanceOutcome<never> => "kind" in value;

    const prepared = await prepare();
    let outcome: ConformanceOutcome<ConformanceStore<unknown, unknown>>;
    if (isOutcome(prepared)) {
      outcome = prepared;
    } else {
      primary = prepared.tables;
      named = new Map([["primary", prepared.tables]]);
      outcome = await open(prepared.tables);
    }

    const context = {
      bigtable: emulator.bigtable,
      instanceId: emulator.instanceId,
    };
    // 履歴は journal の active な行と、まだ書き出されていない head の末尾の履歴である。
    const readHistory = async (id: { typeName: string; value: string }) => {
      assert.ok(primary, "the primary tables must exist");
      const aid = `${id.typeName}-${id.value}`;
      const prefix = aggregatePrefix(aid);
      const head = await readHead(
        new BigtableTableRequests(context, primary.head),
        prefix,
        aid,
      );
      if (head === undefined) return { active: [], marked: [] };
      const [start, end] = journalRange(prefix, 1, head.seqNr + 1);
      const rows = await new BigtableTableRequests(
        context,
        primary.journal,
      ).readRange(
        start,
        end,
        chain([column(FAMILY_HISTORY, HISTORY_STATE), latestCell()]),
      );
      const active = rows
        .filter((row) => {
          const state = cellValue(row, FAMILY_HISTORY, HISTORY_STATE);
          return state !== undefined && Buffer.from(state).equals(STATE_ACTIVE);
        })
        .map((row) =>
          BigInt(Buffer.from(row.key).readBigUInt64BE(row.key.length - 8)),
        );
      const tailRowExists = rows.some(
        (row) =>
          Number(Buffer.from(row.key).readBigUInt64BE(row.key.length - 8)) ===
          head.seqNr,
      );
      if (config.retentionCount !== null && head.hasSnapshot && !tailRowExists)
        active.push(BigInt(head.seqNr));
      return { active: active.sort((a, b) => (a < b ? -1 : 1)), marked: [] };
    };

    return {
      outcome,
      hooks: {
        createStore: async (request) => {
          let tables: BigtableTables | undefined;
          if (request.storage === "new") {
            const next = await prepare();
            if (isOutcome(next)) return next;
            tables = next.tables;
          } else {
            tables = named.get(request.sharedWith ?? "");
          }
          assert.ok(tables, "shared_with store must be registered");
          const created = await open(tables);
          if (created.kind === "ok")
            named = new Map([...named, [request.name, tables]]);
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
      // テーブルは使い捨てのエミュレーターに残る。クライアントは stop で閉じる。
      dispose: async () => undefined,
    };
  }
}
