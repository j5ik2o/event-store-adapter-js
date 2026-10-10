import {
  eventInputOf,
  expectedEventOf,
  snapshotInputOf,
} from "./conformance-fixtures";

test("converts declared metadata while preserving payload JSON and native Date precision", () => {
  const fixture = {
    aggregate_id: { type_name: "Order", value: "1" },
    seq_nr: BigInt(2),
    occurred_at: BigInt(-1),
    payload: { n: 9007199254740992, ok: true },
  };
  expect(eventInputOf(fixture)).toEqual({
    aggregateId: { typeName: "Order", value: "1" },
    seqNr: BigInt(2),
    occurredAtEpochNanos: BigInt(-1),
    payload: fixture.payload,
  });
  expect(expectedEventOf(fixture)).toEqual({
    ...eventInputOf(fixture),
    manifest: "",
    occurredAtEpochNanos: BigInt(-1000000),
  });
  expect(
    snapshotInputOf({
      seq_nr: BigInt(2),
      manifest: "v1",
      aggregate: { total: 1 },
    }),
  ).toEqual({ seqNr: BigInt(2), manifest: "v1", aggregate: { total: 1 } });
});
