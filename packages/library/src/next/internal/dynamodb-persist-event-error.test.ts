import {
  type CancellationReason,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { classifyDynamoDBPersistEventError } from "./dynamodb-persist-event-error";

const none = { Code: "None" };
const condition = (seq?: string): CancellationReason => ({
  Code: "ConditionalCheckFailed",
  ...(seq === undefined ? {} : { Item: { seq_nr: { N: seq } } }),
});

test.each<
  [string, number, CancellationReason[] | undefined, string, number | undefined]
>([
  [
    "journal conflict overrides head gap",
    4,
    [{ Code: "TransactionConflict" }, condition("1")],
    "optimistic-lock-conflict",
    undefined,
  ],
  [
    "head conflict overrides journal condition",
    4,
    [condition(), { Code: "TransactionConflict" }],
    "optimistic-lock-conflict",
    undefined,
  ],
  [
    "conflict in any position overrides conditions",
    4,
    [condition(), condition("1"), { Code: "TransactionConflict" }],
    "optimistic-lock-conflict",
    undefined,
  ],
  [
    "head gap overrides journal condition",
    4,
    [condition(), condition("1")],
    "contract-violation",
    undefined,
  ],
  ["head duplicate", 2, [none, condition("2")], "optimistic-lock-conflict", 2],
  [
    "head stale sequence",
    2,
    [none, condition("3")],
    "optimistic-lock-conflict",
    3,
  ],
  [
    "head creation already exists",
    1,
    [condition(), condition("2")],
    "optimistic-lock-conflict",
    2,
  ],
  [
    "no old head is zero",
    2,
    [none, condition()],
    "contract-violation",
    undefined,
  ],
  [
    "new creation condition without old head",
    1,
    [none, condition()],
    "optimistic-lock-conflict",
    0,
  ],
  [
    "journal condition overrides other failure",
    2,
    [condition(), { Code: "ThrottlingError" }],
    "optimistic-lock-conflict",
    undefined,
  ],
  [
    "journal condition alone",
    2,
    [condition(), none],
    "optimistic-lock-conflict",
    undefined,
  ],
  [
    "other cancellation",
    2,
    [none, { Code: "ValidationError" }],
    "storage-error",
    undefined,
  ],
  ["reasons missing", 2, undefined, "storage-error", undefined],
  ["reasons empty", 2, [], "storage-error", undefined],
  [
    "invalid head number",
    2,
    [none, condition("not-a-number")],
    "storage-error",
    undefined,
  ],
  [
    "unsafe head number",
    2,
    [none, condition("9007199254740992")],
    "storage-error",
    undefined,
  ],
  ["zero head number", 2, [none, condition("0")], "storage-error", undefined],
  [
    "condition with an actually matching head",
    2,
    [none, condition("1")],
    "storage-error",
    undefined,
  ],
])("%s", (_name, seqNr, CancellationReasons, type, headSeqNr) => {
  const cause = new TransactionCanceledException({
    $metadata: {},
    message: "sdk-private-diagnostic",
    CancellationReasons,
  });
  const result = classifyDynamoDBPersistEventError(cause, "Order-1", seqNr);
  expect(result.type).toBe(type);
  expect(result.cause).toBe(cause);
  expect(result.message).not.toContain(cause.message);
  if (result.type === "contract-violation") {
    expect(result.rule).toBe("W-8");
    expect(result.seqNr).toBe(seqNr);
    expect(result.message).toContain("W-8");
  }
  if (result.type === "optimistic-lock-conflict") {
    expect(result).toMatchObject({ aggregateId: "Order-1", seqNr });
    expect(result.headSeqNr).toBe(headSeqNr);
  }
});

test("old head missing seq_nr stays a storage failure", () => {
  const cause = new TransactionCanceledException({
    $metadata: {},
    message: "missing head sequence",
    CancellationReasons: [
      none,
      { Code: "ConditionalCheckFailed", Item: { aid: { S: "Order-1" } } },
    ],
  });
  expect(classifyDynamoDBPersistEventError(cause, "Order-1", 2).type).toBe(
    "storage-error",
  );
});

test("non-cancellation exceptions and non-Error causes are retained", () => {
  for (const cause of [
    new Error("private-diagnostic"),
    "private-value",
    undefined,
  ]) {
    expect(classifyDynamoDBPersistEventError(cause, "Order-1", 1)).toEqual({
      type: "storage-error",
      message: "event transaction failed",
      ...(cause === undefined ? {} : { cause }),
    });
  }
});
