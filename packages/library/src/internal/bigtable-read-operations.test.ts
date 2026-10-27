import { PayloadSerializer } from "../payload-serializer";
import {
  encodeEventEnvelope,
  encodeSnapshotEnvelope,
} from "./bigtable-envelope";
import { createBigtableGetEvents } from "./bigtable-get-events";
import { createBigtableGetLatestSnapshot } from "./bigtable-get-latest-snapshot";
import { formatHeadSeqNr } from "./bigtable-head";
import { BigtableTableRequests } from "./bigtable-requests";
import { aggregatePrefix, journalRowKey } from "./bigtable-row-keys";
import type { BigtableStoreResources } from "./bigtable-store-resources";
import {
  type FakeStreamItem,
  fakeBigtable,
  rowResponse,
} from "./test/bigtable-fake-client";

const id = { typeName: "Order", value: "1" };
const AID = "Order-1";
const prefix = aggregatePrefix(AID);
const json = new TextEncoder();
const eventOf = (seqNr: number, over: { aid?: string; ns?: bigint } = {}) =>
  encodeEventEnvelope({
    aid: over.aid ?? AID,
    seqNr,
    occurredAtNs: over.ns ?? BigInt(0),
    manifest: "m",
    payload: json.encode(JSON.stringify({ seqNr })),
  });
const headRow = (seqNr: number, snapshot?: Uint8Array) =>
  rowResponse(prefix, [
    ["head", "seq_nr", formatHeadSeqNr(seqNr)],
    ["head", "last_event", eventOf(seqNr)],
    ["head", "has_snapshot", snapshot === undefined ? "0" : "1"],
    ...(snapshot === undefined
      ? []
      : ([["snapshot", "current", snapshot]] as const)),
  ]);
const journalRow = (
  seqNr: number,
  cells?: readonly (readonly [string, string, Uint8Array | string])[],
  key = journalRowKey(prefix, seqNr),
) => rowResponse(key, cells ?? [["event", "envelope", eventOf(seqNr)]]);

const resourcesOf = (
  streams: FakeStreamItem[][],
  serializers: {
    event?: PayloadSerializer<unknown>;
    snapshot?: PayloadSerializer<unknown>;
  } = {},
) => {
  let call = 0;
  const bigtable = fakeBigtable({ stream: () => streams[call++] ?? [] });
  const table = new BigtableTableRequests(
    { bigtable, instanceId: "inst" },
    "t",
  );
  return {
    settings: {
      eventSerializer: serializers.event ?? PayloadSerializer.json(),
      snapshotSerializer: serializers.snapshot ?? PayloadSerializer.json(),
    },
    journal: table,
    head: table,
    hooks: undefined,
  } as unknown as BigtableStoreResources<unknown, unknown>;
};
const failing: PayloadSerializer<unknown> = {
  serialize: () => new Uint8Array(),
  deserialize: () => {
    throw new Error("cannot deserialize");
  },
};

describe("getEventsByIdSinceSeqNr", () => {
  test("rejects an invalid aggregate id and an invalid sequence number before any read", async () => {
    const get = createBigtableGetEvents(resourcesOf([]));
    expect((await get({ typeName: "A-B", value: "1" }, 1)).type).toBe("err");
    expect((await get(id, -1)).type).toBe("err");
  });

  test("reads the journal range and the head event, flooring negative nanoseconds", async () => {
    const get = createBigtableGetEvents(
      resourcesOf([[headRow(2)], [journalRow(1)]]),
    );
    const result = await get(id, 1);
    expect(result.type === "ok" && result.value.map((e) => e.seqNr)).toEqual([
      1, 2,
    ]);
    const floored = createBigtableGetEvents(
      resourcesOf([
        [
          rowResponse(prefix, [
            ["head", "seq_nr", formatHeadSeqNr(1)],
            ["head", "last_event", eventOf(1, { ns: BigInt(-1) })],
            ["head", "has_snapshot", "0"],
          ]),
        ],
      ]),
    );
    const read = await floored(id, 1);
    expect(read.type === "ok" && read.value[0].occurredAt.getTime()).toBe(-1);
  });

  test.each([
    [
      "a journal row at the wrong seq_nr",
      journalRow(1, undefined, journalRowKey(prefix, 5)),
    ],
    [
      "a journal row without an event envelope",
      journalRow(1, [["history", "state", "active"]]),
    ],
    [
      "a journal row of another aggregate",
      journalRow(1, [["event", "envelope", eventOf(1, { aid: "Order-2" })]]),
    ],
  ])("%s is a storage error", async (_name, row) => {
    const get = createBigtableGetEvents(resourcesOf([[headRow(2)], [row]]));
    expect(await get(id, 1)).toMatchObject({
      type: "err",
      error: { type: "storage-error" },
    });
  });

  test("a payload that cannot be deserialized is a serialization error", async () => {
    const get = createBigtableGetEvents(
      resourcesOf([[headRow(1)]], { event: failing }),
    );
    expect(await get(id, 1)).toMatchObject({
      type: "err",
      error: { type: "serialization-error", operation: "deserialize" },
    });
  });
});

describe("getLatestSnapshotById", () => {
  test("rejects an invalid aggregate id", async () => {
    const get = createBigtableGetLatestSnapshot(resourcesOf([]));
    expect((await get({ typeName: "A-B", value: "1" })).type).toBe("err");
  });

  test("returns the head number alone when no snapshot exists", async () => {
    const get = createBigtableGetLatestSnapshot(resourcesOf([[headRow(1)]]));
    expect(await get(id)).toEqual({ type: "ok", value: { headSeqNr: 1 } });
  });

  test("a snapshot that cannot be deserialized is a serialization error", async () => {
    const snapshot = encodeSnapshotEnvelope({
      seqNr: 1,
      manifest: "s",
      payload: new Uint8Array(),
    });
    const get = createBigtableGetLatestSnapshot(
      resourcesOf([[headRow(1, snapshot)]], { snapshot: failing }),
    );
    expect(await get(id)).toMatchObject({
      type: "err",
      error: { type: "serialization-error", operation: "deserialize" },
    });
  });
});
