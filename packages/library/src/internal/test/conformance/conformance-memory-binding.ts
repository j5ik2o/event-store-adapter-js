import assert from "node:assert/strict";
import { EventStore } from "../../../event-store";
import type { MemoryEventStoreInput } from "../../../memory-event-store-input";
import { MemoryStorage } from "../../../memory-storage";
import * as memoryFactory from "../../memory-event-store";
import { inspectMemoryStorageRecords } from "../../memory-storage-records";
import type { ConformanceCreatedStore } from "./conformance-created-store";
import { ConformanceFaultRegistry } from "./conformance-fault-registry";
import { listOf, recordOf } from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";
import type { ConformanceOutcome } from "./conformance-outcome";
import { ConformancePublicBinding } from "./conformance-public-binding";
import type { ConformanceStore } from "./conformance-store";
import type { ConformanceStoreCreation } from "./conformance-store-creation";

export class ConformanceMemoryBinding extends ConformancePublicBinding {
  readonly backend = "memory";

  async createStore(
    creation: ConformanceStoreCreation,
  ): Promise<ConformanceCreatedStore<unknown, unknown>> {
    const registry = new ConformanceFaultRegistry(creation.faults);
    let notifications: string[] = [];
    let observations: unknown[] = [];
    const createStorage = () =>
      MemoryStorage.create({
        ...(creation.config.changeFeed === true ? { changeFeed: true } : {}),
        retention:
          creation.config.retentionCount === null
            ? undefined
            : {
                count: creation.config.retentionCount,
                mode:
                  creation.config.retentionMode === "ttl"
                    ? {
                        type: "ttl",
                        graceSeconds: creation.config.ttlGraceSeconds as number,
                      }
                    : { type: "delete" },
              },
      });
    const storage = createStorage();
    let storages: ReadonlyMap<string, typeof storage> = new Map([
      ["primary", storage],
    ]);
    const fail = (phase: string) => {
      const fault = registry.take(phase);
      if (fault === undefined) return;
      assert.equal(fault.declaration.injection, "replace-request");
      assert.equal(fault.declaration.kind, "storage-error");
      registry.applied(fault.index);
      throw new Error(String(recordOf(fault.declaration.details).message));
    };
    const original = memoryFactory.createMemoryEventStoreInternal;
    const wrapper = jest
      .spyOn(memoryFactory, "createMemoryEventStoreInternal")
      .mockImplementation(<PE, PS>(input?: MemoryEventStoreInput<PE, PS>) =>
        original(input, {
          beforeCommit: () => fail("commit"),
          beforeReadEvents: () => fail("read-events"),
          beforeReadSnapshot: () => fail("read-snapshot"),
          beforeDelete: () => fail("retention-delete"),
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
            const pages = listOf(
              recordOf(fault.declaration.details).history_pages,
            );
            const listed = pages.flatMap((page) => listOf(page).map(Number));
            assert.ok(
              listed.every((n) => seqNrs.includes(n)),
              "history plan must use stored history",
            );
            registry.applied(fault.index);
            return listed;
          },
        }),
      );
    const open = (
      target: ReturnType<typeof createStorage>,
    ): ConformanceOutcome<ConformanceStore<unknown, unknown>> => {
      let opened: ReturnType<
        typeof EventStore.createMemory<
          ConformanceJsonValue,
          ConformanceJsonValue
        >
      >;
      try {
        opened =
          target.type === "err"
            ? target
            : EventStore.createMemory<
                ConformanceJsonValue,
                ConformanceJsonValue
              >({
                storage: target.value,
                eventSerializer: this.serializer(registry, "event"),
                snapshotSerializer: this.serializer(registry, "snapshot"),
                onRetentionFailure: (failure) => {
                  notifications = [...notifications, failure.kind];
                },
                logger: { ...console, error: () => undefined },
              });
      } finally {
        wrapper.mockRestore();
      }
      return opened.type === "err"
        ? this.outcome<never>(opened)
        : { kind: "ok" as const, value: this.wrapStore(opened.value) };
    };
    return {
      outcome: open(storage),
      hooks: {
        createStore: async (request) => {
          const target =
            request.storage === "new"
              ? createStorage()
              : storages.get(request.sharedWith ?? "");
          assert.ok(target, "shared_with store must be registered");
          const outcome = open(target);
          if (outcome.kind === "ok")
            storages = new Map([...storages, [request.name, target]]);
          return outcome;
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
        readHistory: async (id: { typeName: string; value: string }) => {
          if (storage.type === "err")
            throw new Error("storage creation failed");
          const physical = await inspectMemoryStorageRecords(storage.value);
          if (physical.type === "err") throw physical.error;
          observations = [...observations, physical.value];
          return {
            active: (
              physical.value.records.get(`${id.typeName}-${id.value}`)
                ?.history ?? []
            ).map((s) => BigInt(s.seqNr)),
            marked: [],
          };
        },
        evidence: () => ({ faults: registry.snapshot(), observations }),
      },
      dispose: async () => undefined,
    };
  }
}
