import assert from "node:assert/strict";
import { expectedEventOf, snapshotInputOf } from "./conformance-fixtures";
import { integerOf, listOf, recordOf, textOf } from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";
import type { ConformanceOutcome } from "./conformance-outcome";

export function compareExpectation(
  expected: ConformanceJsonValue,
  actual: ConformanceOutcome<unknown>,
  fixtures: ConformanceJsonValue,
  args: ConformanceJsonValue,
): void {
  const expectation = recordOf(expected);
  if (expectation.error !== undefined) {
    const error = recordOf(expectation.error);
    assert.ok(actual.kind === "error", "expected operation failure");
    assert.equal(actual.category, error.category);
    if (error.rule !== undefined) assert.equal(actual.rule, error.rule);
    if (error.message !== undefined) {
      const conditions = recordOf(error.message);
      for (const text of listOf(conditions.must_contain ?? []))
        assert.ok(
          actual.message.includes(textOf(text)),
          `message must contain ${String(text)}`,
        );
      for (const text of listOf(conditions.must_not_contain ?? []))
        assert.ok(
          !actual.message.includes(textOf(text)),
          `message must not contain ${String(text)}`,
        );
    }
    return;
  }
  assert.ok(actual.kind === "ok", "expected operation success");
  switch (expectation.result) {
    case "success":
      return;
    case "none":
      assert.deepEqual(actual.value, { kind: "none" });
      return;
    case "events": {
      const events = recordOf(recordOf(fixtures).events);
      assert.deepEqual(
        actual.value,
        listOf(expectation.events).map((reference) =>
          expectedEventOf(events[textOf(reference)]),
        ),
      );
      return;
    }
    case "snapshot": {
      const snapshot =
        expectation.snapshot === null
          ? null
          : snapshotInputOf(
              recordOf(recordOf(fixtures).snapshots)[
                textOf(expectation.snapshot)
              ],
            );
      assert.deepEqual(actual.value, {
        kind: "snapshot",
        headSeqNr: integerOf(expectation.head_seq_nr),
        snapshot:
          snapshot === null
            ? null
            : {
                ...snapshot,
                manifest: snapshot.manifest ?? "",
                aggregateId: (() => {
                  const id = recordOf(recordOf(args).aggregate_id);
                  return { typeName: id.type_name, value: id.value };
                })(),
              },
      });
      return;
    }
    default:
      throw new Error(
        `unsupported expected result ${String(expectation.result)}`,
      );
  }
}
