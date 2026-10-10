import assert from "node:assert/strict";
import { aggregateIdInputOf } from "./conformance-aggregate-id-input";
import type { ConformanceCase } from "./conformance-case";
import type { ConformanceCaseResult } from "./conformance-case-result";
import { withCaseStore } from "./conformance-case-store-scope";
import { compareExpectation } from "./conformance-expectation";
import { eventInputOf, snapshotInputOf } from "./conformance-fixtures";
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
import type { ConformanceStore } from "./conformance-store";
import type { ConformanceStoreBinding } from "./conformance-store-binding";
import { storeCreationOf } from "./conformance-store-creation";
import { nativeTimeEpochNanos } from "./conformance-time";

export async function executeConformanceOperation(
  binding: ConformanceStoreBinding<unknown, unknown>,
  store: ConformanceStore<unknown, unknown>,
  operation: ConformanceJsonValue,
  fixtures: ConformanceJsonValue,
): Promise<ConformanceOutcome<unknown>> {
  const step = recordOf(operation);
  const args = recordOf(step.arguments);
  switch (step.op) {
    case "persistEvent":
    case "persistEventAndSnapshot": {
      const event = binding.buildEvent(
        eventInputOf(jsonAt(fixtures, "events", textOf(args.event))),
      );
      if (event.kind === "error") return event;
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
          actual = await executeConformanceOperation(
            binding,
            store,
            operation,
            fixtures,
          );
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
            const args = recordOf(step.arguments);
            const id =
              args.aggregate_id ??
              jsonAt(fixtures, "events", textOf(args.event), "aggregate_id");
            const physical = await created.hooks.readHistory(aggregateIdOf(id));
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
