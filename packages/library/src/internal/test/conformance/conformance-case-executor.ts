import assert from "node:assert/strict";
import { aggregateIdInputOf } from "./conformance-aggregate-id-input";
import type { ConformanceCase } from "./conformance-case";
import type { ConformanceCaseResult } from "./conformance-case-result";
import { withCaseStore } from "./conformance-case-store-scope";
import { compareExpectation } from "./conformance-expectation";
import { eventInputOf, snapshotInputOf } from "./conformance-fixtures";
import type { ConformanceHooks } from "./conformance-hooks";
import {
  aggregateIdOf,
  integerOf,
  listOf,
  recordOf,
  textOf,
} from "./conformance-json-access";
import { jsonAt } from "./conformance-json-lookup";
import type { ConformanceJsonValue } from "./conformance-json-value";
import type { ConformanceOutcome } from "./conformance-outcome";
import { mutateConformancePayload } from "./conformance-payload-mutation";
import type { ConformanceStore } from "./conformance-store";
import type { ConformanceStoreBinding } from "./conformance-store-binding";
import { storeCreationOf } from "./conformance-store-creation";
import { nativeTimeEpochNanos } from "./conformance-time";

const operationAggregateIdOf = (
  step: ReturnType<typeof recordOf>,
  fixtures: ConformanceJsonValue,
): ConformanceJsonValue | undefined => {
  const args = recordOf(step.arguments);
  return (
    args.aggregate_id ??
    jsonAt(fixtures, "events", textOf(args.event), "aggregate_id")
  );
};

type CaseStores = ReadonlyMap<string, ConformanceStore<unknown, unknown>>;
type WrittenPayloads = ReadonlyMap<number, ConformanceJsonValue>;
type ReadResults = ReadonlyMap<number, readonly { payload: unknown }[]>;

// createStore 手順の引数を検査し、フックでストアを生成して登録する
const createCaseStore = async (
  hooks: ConformanceHooks,
  stores: CaseStores,
  args: ReturnType<typeof recordOf>,
): Promise<{
  outcome: ConformanceOutcome<unknown>;
  stores: CaseStores;
}> => {
  const name = textOf(args.name);
  const storage = textOf(args.storage);
  assert.ok(
    name !== "primary" && !stores.has(name),
    `store name ${name} must be new`,
  );
  assert.ok(
    storage === "new" || storage === "shared",
    `unsupported storage ${storage}`,
  );
  const sharedWith =
    args.shared_with === undefined ? undefined : textOf(args.shared_with);
  assert.ok(
    storage === "new" || (sharedWith !== undefined && stores.has(sharedWith)),
    "shared_with must name a registered store",
  );
  assert.ok(hooks.createStore, "store creation must be connected");
  const made = await hooks.createStore({
    name,
    storage,
    ...(sharedWith === undefined ? {} : { sharedWith }),
  });
  if (made.kind === "error") return { outcome: made, stores };
  return {
    outcome: { kind: "ok", value: undefined },
    stores: new Map([...stores, [name, made.value]]),
  };
};

// mutate* 手順が書き換える対象のペイロードの実体を特定する
const mutationTargetOf = (
  op: "mutateWrittenPayload" | "mutateReadPayload",
  args: ReturnType<typeof recordOf>,
  steps: readonly ConformanceJsonValue[],
  written: WrittenPayloads,
  reads: ReadResults,
): ConformanceJsonValue => {
  const operation = Number(integerOf(args.operation));
  let payload: ConformanceJsonValue | undefined;
  if (op === "mutateWrittenPayload") {
    payload = written.get(operation);
  } else {
    const names = listOf(
      recordOf(recordOf(steps[operation - 1]).expect).events ?? [],
    ).map(textOf);
    const position = names.indexOf(textOf(args.event));
    payload =
      position < 0
        ? undefined
        : (reads.get(operation)?.[position]?.payload as ConformanceJsonValue);
  }
  assert.ok(payload !== undefined, "mutation target must exist");
  return payload;
};

export async function executeConformanceOperation(
  binding: ConformanceStoreBinding<unknown, unknown>,
  store: ConformanceStore<unknown, unknown>,
  operation: ConformanceJsonValue,
  fixtures: ConformanceJsonValue,
  onWrittenPayload?: (payload: ConformanceJsonValue) => void,
): Promise<ConformanceOutcome<unknown>> {
  const step = recordOf(operation);
  const args = recordOf(step.arguments);
  switch (step.op) {
    case "persistEvent":
    case "persistEventAndSnapshot": {
      const input = eventInputOf(
        jsonAt(fixtures, "events", textOf(args.event)),
      );
      // fixture を書き換えると期待値も変わるため、書き込みには複製を渡す
      const written = structuredClone(input.payload);
      const event = binding.buildEvent({ ...input, payload: written });
      if (event.kind === "error") return event;
      onWrittenPayload?.(written);
      if (step.op === "persistEvent") return store.persistEvent(event.value);
      const snapshot = binding.buildSnapshot(
        snapshotInputOf(jsonAt(fixtures, "snapshots", textOf(args.snapshot))),
      );
      if (snapshot.kind === "error") return snapshot;
      return store.persistEventAndSnapshot(event.value, snapshot.value);
    }
    case "getLatestSnapshotById":
      return store.getLatestSnapshotById(aggregateIdOf(args.aggregate_id));
    case "getEventsByIdSinceSeqNr":
      return store.getEventsByIdSinceSeqNr(
        aggregateIdOf(args.aggregate_id),
        integerOf(args.seq_nr),
      );
    default:
      throw new Error(`unsupported operation ${String(step.op)}`);
  }
}

export async function executeConformanceCase(
  c: ConformanceCase,
  binding: ConformanceStoreBinding<unknown, unknown>,
): Promise<ConformanceCaseResult> {
  const base = { caseId: c.id, rules: c.rules, source: c.source };
  let failedOperation = 0;
  let expected: unknown;
  let actual: unknown;
  let storageEvidence: unknown;
  const operations: unknown[] = [];
  try {
    const body = recordOf(c.body);
    if (c.format === "values" && body.operation !== "validateOccurredAt") {
      const input = recordOf(body.input);
      const expectation = recordOf(body.expect);
      const result =
        body.operation === "buildAid"
          ? binding.buildAggregateId(aggregateIdInputOf(c))
          : body.operation === "fnv1a64"
            ? (() => {
                assert.ok(
                  binding.fnv1a64,
                  "fnv1a64 must be connected to the library hash",
                );
                return {
                  kind: "ok" as const,
                  value: `0x${binding
                    .fnv1a64(textOf(input.utf8))
                    .toString(16)
                    .padStart(16, "0")}`,
                };
              })()
            : body.operation === "encodeBigtableEventEnvelope"
              ? (() => {
                  assert.ok(
                    binding.encodeBigtableEventEnvelope,
                    "encodeBigtableEventEnvelope must be connected to the envelope codec",
                  );
                  return binding.encodeBigtableEventEnvelope({
                    aid: textOf(input.aid),
                    seqNr: Number(integerOf(input.seq_nr)),
                    occurredAtNs: BigInt(textOf(input.occurred_at_ns)),
                    manifest: textOf(input.manifest),
                    payloadHex: textOf(input.payload_hex),
                  });
                })()
              : body.operation === "encodeBigtableSnapshotEnvelope"
                ? (() => {
                    assert.ok(
                      binding.encodeBigtableSnapshotEnvelope,
                      "encodeBigtableSnapshotEnvelope must be connected to the envelope codec",
                    );
                    return binding.encodeBigtableSnapshotEnvelope({
                      seqNr: Number(integerOf(input.seq_nr)),
                      manifest: textOf(input.manifest),
                      payloadHex: textOf(input.payload_hex),
                    });
                  })()
                : body.operation === "decodeBigtableEnvelope"
                  ? (() => {
                      assert.ok(
                        binding.decodeBigtableEnvelope,
                        "decodeBigtableEnvelope must be connected to the envelope codec",
                      );
                      return binding.decodeBigtableEnvelope({
                        kind: textOf(input.kind) as "event" | "snapshot",
                        bytesHex: textOf(input.bytes_hex),
                      });
                    })()
                  : body.operation === "validateSeqNr"
                    ? binding.validateSeqNrValue(
                        integerOf(input.seq_nr),
                        textOf(input.context) as "event" | "value",
                      )
                    : (() => {
                        throw new Error(
                          `unsupported value operation ${String(body.operation)}`,
                        );
                      })();
      expected = expectation;
      actual = result;
      if (expectation.error !== undefined)
        compareExpectation(expectation, result, {}, {});
      else {
        assert.ok(result.kind === "ok");
        assert.deepEqual(result.value, expectation.value);
      }
      return {
        ...base,
        status: "passed",
        reason: "",
        evidence: { expected, actual },
      };
    }
    await withCaseStore(binding, storeCreationOf(c), async (created) => {
      try {
        expected =
          body.initialization === undefined
            ? { result: "success" }
            : recordOf(body.initialization).expect;
        actual = created.outcome;
        compareExpectation(
          expected as ConformanceJsonValue,
          created.outcome,
          {},
          {},
        );
        created.hooks.finishOperation?.(0);
        if (body.initialization !== undefined) {
          const observe = recordOf(body.initialization).observe;
          if (observe !== undefined) {
            assert.ok(
              created.hooks.checkStorageObservation,
              "initialization observation must be connected",
            );
            await created.hooks.checkStorageObservation(observe, {});
          }
        }
        operations.push({
          operation: 0,
          expected,
          actual:
            created.outcome.kind === "ok" ? { kind: "ok" } : created.outcome,
        });
        if (created.outcome.kind === "error") return;
        const store = created.outcome.value;
        let stores: ReadonlyMap<string, typeof store> = new Map([
          ["primary", store],
        ]);
        let written: ReadonlyMap<number, ConformanceJsonValue> = new Map();
        let reads: ReadonlyMap<number, readonly { payload: unknown }[]> =
          new Map();
        if (c.format === "layout") {
          assert.ok(
            created.hooks.checkLayout,
            "layout verification must be connected",
          );
          await created.hooks.checkLayout(c.body);
          return;
        }
        if (c.format === "values") {
          const input = recordOf(body.input);
          const aggregateId = { typeName: "ConformanceTime", value: c.id };
          const seqNr = Number(integerOf(input.event_seq_nr));
          for (let n = 1; n <= seqNr; n += 1) {
            failedOperation = n;
            created.hooks.beginOperation?.(n);
            const built = binding.buildEvent({
              aggregateId,
              seqNr: BigInt(n),
              payload: {},
              manifest: "",
              occurredAtEpochNanos:
                n === seqNr
                  ? integerOf(input.epoch_nanoseconds)
                  : BigInt(123000000),
            });
            const written =
              built.kind === "error"
                ? built
                : await store.persistEvent(built.value);
            expected =
              n === seqNr && recordOf(body.expect).error !== undefined
                ? body.expect
                : { result: "success" };
            actual = written;
            compareExpectation(
              expected as ConformanceJsonValue,
              written,
              {},
              {},
            );
            created.hooks.finishOperation?.(n);
            operations.push({ operation: n, expected, actual });
          }
          if (recordOf(body.expect).error === undefined) {
            const read = await store.getEventsByIdSinceSeqNr(
              aggregateId,
              BigInt(1),
            );
            assert.ok(read.kind === "ok", "time read failed");
            assert.equal(read.value.length, seqNr);
            const native = nativeTimeEpochNanos(
              integerOf(input.epoch_nanoseconds),
            );
            expected = native;
            actual = read.value[0].occurredAtEpochNanos;
            assert.equal(actual, native);
            operations.push({
              original: input.epoch_nanoseconds,
              converted: native,
              actual,
            });
          }
          return;
        }
        const fixtures = body.fixtures ?? {};
        for (const [index, operation] of listOf(body.steps ?? []).entries()) {
          failedOperation = index + 1;
          const step = recordOf(operation);
          created.hooks.beginOperation?.(failedOperation);
          if (step.clock_epoch_seconds !== undefined) {
            assert.ok(
              created.hooks.setClockEpochSeconds,
              "clock hook must be connected",
            );
            created.hooks.setClockEpochSeconds(
              Number(integerOf(step.clock_epoch_seconds)),
            );
          }
          expected = step.expect;
          const stepArgs = recordOf(step.arguments);
          if (step.op === "createStore") {
            const made = await createCaseStore(created.hooks, stores, stepArgs);
            stores = made.stores;
            actual = made.outcome;
          } else if (
            step.op === "holdWriteLock" ||
            step.op === "releaseWriteLock"
          ) {
            const lock =
              step.op === "holdWriteLock"
                ? created.hooks.holdWriteLock
                : created.hooks.releaseWriteLock;
            assert.ok(lock, `${String(step.op)} hook must be connected`);
            await lock();
            actual = { kind: "ok", value: undefined };
          } else if (
            step.op === "mutateWrittenPayload" ||
            step.op === "mutateReadPayload"
          ) {
            mutateConformancePayload(
              mutationTargetOf(
                step.op,
                stepArgs,
                listOf(body.steps ?? []),
                written,
                reads,
              ),
              textOf(stepArgs.pointer),
              stepArgs.value,
            );
            actual = { kind: "ok", value: undefined };
          } else {
            const target = stores.get(
              step.store === undefined ? "primary" : textOf(step.store),
            );
            assert.ok(target, "operation must target a registered store");
            actual = await executeConformanceOperation(
              binding,
              target,
              operation,
              fixtures,
              (payload) => {
                written = new Map([...written, [failedOperation, payload]]);
              },
            );
            const outcome = actual as ConformanceOutcome<unknown>;
            if (step.op === "getEventsByIdSinceSeqNr" && outcome.kind === "ok")
              reads = new Map([
                ...reads,
                [
                  failedOperation,
                  outcome.value as readonly { payload: unknown }[],
                ],
              ]);
          }
          compareExpectation(
            step.expect,
            actual as ConformanceOutcome<unknown>,
            fixtures,
            step.arguments,
          );
          await created.hooks.awaitRetention?.();
          const observe = recordOf(step.observe ?? {});
          const observations: Record<string, unknown> = {};
          const notifications = created.hooks.takeRetentionFailures?.();
          if (observe.notifications !== undefined) {
            assert.ok(
              notifications,
              "notification observation must be connected",
            );
            assert.deepEqual(notifications, observe.notifications);
            observations.notifications = notifications;
          }
          if (observe.history !== undefined) {
            const history = recordOf(observe.history);
            assert.ok(
              created.hooks.readHistory,
              "history observation must be connected",
            );
            const physical = await created.hooks.readHistory(
              aggregateIdOf(operationAggregateIdOf(step, fixtures)),
            );
            const active = [...physical.active].sort((a, b) =>
              a < b ? -1 : a > b ? 1 : 0,
            );
            assert.deepEqual(
              active,
              listOf(history.active)
                .map(integerOf)
                .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
            );
            assert.deepEqual(
              [...physical.marked].sort((a, b) => Number(a.seqNr - b.seqNr)),
              listOf(history.marked)
                .map((entry) => {
                  const marked = recordOf(entry);
                  return {
                    seqNr: integerOf(marked.seq_nr),
                    expires: Number(integerOf(marked.ttl)),
                  };
                })
                .sort((a, b) => Number(a.seqNr - b.seqNr)),
            );
            for (const absent of listOf(history.absent))
              assert.ok(
                ![
                  ...physical.active,
                  ...physical.marked.map((m) => m.seqNr),
                ].includes(integerOf(absent)),
                "absent history exists",
              );
            observations.history = physical;
          }
          const storageKeys = Object.keys(observe).filter(
            (key) => key !== "history" && key !== "notifications",
          );
          if (
            storageKeys.length > 0 ||
            created.hooks.checkStorageObservation !== undefined
          ) {
            assert.ok(
              created.hooks.checkStorageObservation,
              "storage observation must be connected",
            );
            await created.hooks.checkStorageObservation(
              observe,
              step.arguments,
              recordOf(observe).request_scope === undefined
                ? undefined
                : aggregateIdOf(operationAggregateIdOf(step, fixtures)),
            );
          }
          created.hooks.finishOperation?.(failedOperation);
          operations.push({
            operation: failedOperation,
            expected,
            actual,
            observations,
          });
        }
      } finally {
        storageEvidence = created.hooks.evidence?.();
      }
    });
    return {
      ...base,
      status: "passed",
      reason: "",
      evidence: { operations, storage: storageEvidence },
    };
  } catch (cause) {
    return {
      ...base,
      status: "failed",
      reason: cause instanceof Error ? cause.message : String(cause),
      failedOperation,
      expected,
      actual,
      evidence: { operations, storage: storageEvidence, failure: cause },
    };
  }
}
