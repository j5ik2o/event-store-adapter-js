import {
  encodeEventEnvelope,
  encodeSnapshotEnvelope,
} from "./bigtable-envelope";
import type { BigtableEventStoreHooks } from "./bigtable-event-store-hooks";
import { formatHeadSeqNr, readHead } from "./bigtable-head";
import { writeJournalRow } from "./bigtable-journal-row";
import { BigtableTableRequests } from "./bigtable-requests";
import { aggregatePrefix, journalRowKey } from "./bigtable-row-keys";
import { retainBigtableHistory } from "./bigtable-snapshot-retention";
import type { BigtableStoreResources } from "./bigtable-store-resources";
import {
  type FakeStreamItem,
  fakeBigtable,
  rowResponse,
} from "./test/bigtable-fake-client";

const AID = "Order-1";
const prefix = aggregatePrefix(AID);
const eventBytes = (seqNr: number, aid = AID) =>
  encodeEventEnvelope({
    aid,
    seqNr,
    occurredAtNs: BigInt(0),
    manifest: "m",
    payload: new Uint8Array(),
  });
const snapshotBytes = (seqNr: number) =>
  encodeSnapshotEnvelope({ seqNr, manifest: "s", payload: new Uint8Array() });

const tableOf = (bigtable: ReturnType<typeof fakeBigtable>) =>
  new BigtableTableRequests({ bigtable, instanceId: "inst" }, "t");
const streamOf = (...items: FakeStreamItem[]) =>
  fakeBigtable({ stream: () => items });

type Cell = readonly [string, string, Uint8Array | string];
const headCells = (over: {
  seq?: Uint8Array | string | null;
  last?: Uint8Array | null;
  flag?: string | null;
  snapshot?: Uint8Array | null;
}): Cell[] => {
  const cells: Cell[] = [];
  if (over.seq !== null)
    cells.push(["head", "seq_nr", over.seq ?? formatHeadSeqNr(3)]);
  if (over.last !== null)
    cells.push(["head", "last_event", over.last ?? eventBytes(3)]);
  if (over.flag !== null)
    cells.push(["head", "has_snapshot", over.flag ?? "0"]);
  if (over.snapshot !== undefined && over.snapshot !== null)
    cells.push(["snapshot", "current", over.snapshot]);
  return cells;
};
const readHeadOf = (cells: readonly Cell[]) =>
  readHead(tableOf(streamOf(rowResponse(prefix, cells))), prefix, AID);

describe("readHead", () => {
  test("no row means no head", async () => {
    await expect(
      readHead(tableOf(streamOf()), prefix, AID),
    ).resolves.toBeUndefined();
  });

  test("a head without a snapshot has no tail snapshot", async () => {
    const head = await readHeadOf(headCells({}));
    expect(head).toMatchObject({ seqNr: 3, hasSnapshot: false });
    expect(head?.tailSnapshotBytes).toBeUndefined();
    expect(head?.currentSnapshot).toBeUndefined();
  });

  test("a head that carries its snapshot exposes the snapshot bytes", async () => {
    const bytes = snapshotBytes(3);
    const head = await readHeadOf(headCells({ flag: "1", snapshot: bytes }));
    expect(
      Buffer.from(head?.tailSnapshotBytes ?? []).equals(Buffer.from(bytes)),
    ).toBe(true);
  });

  test("an older snapshot is kept as the current one but is not the tail snapshot", async () => {
    const head = await readHeadOf(
      headCells({ flag: "0", snapshot: snapshotBytes(2) }),
    );
    expect(head?.currentSnapshot?.fields.seqNr).toBe(2);
    expect(head?.tailSnapshotBytes).toBeUndefined();
  });

  test.each([
    ["a head seq_nr of the wrong length", headCells({ seq: "123" })],
    [
      "a head seq_nr that is not digits",
      headCells({ seq: "0000000000000000000x" }),
    ],
    ["a head seq_nr of 0", headCells({ seq: "00000000000000000000" })],
    ["a head seq_nr above 2^53-1", headCells({ seq: "99999999999999999999" })],
    ["a missing seq_nr", headCells({ seq: null })],
    ["a missing last event", headCells({ last: null })],
    [
      "a last event of another aid",
      headCells({ last: eventBytes(3, "Order-2") }),
    ],
    ["a last event of another seq_nr", headCells({ last: eventBytes(2) })],
    ["a missing has_snapshot flag", headCells({ flag: null })],
    ["an invalid has_snapshot flag", headCells({ flag: "2" })],
    ["a snapshot flag without a snapshot", headCells({ flag: "1" })],
    [
      "a snapshot flag with another seq_nr",
      headCells({ flag: "1", snapshot: snapshotBytes(2) }),
    ],
    [
      "a snapshot of the head seq_nr without the flag",
      headCells({ flag: "0", snapshot: snapshotBytes(3) }),
    ],
  ])("rejects %s as a storage error", async (_name, cells) => {
    await expect(readHeadOf(cells)).rejects.toMatchObject({
      type: "storage-error",
    });
  });
});

describe("writeJournalRow", () => {
  const event = eventBytes(1);
  const history = snapshotBytes(1);
  const row = (cells: readonly Cell[]) =>
    rowResponse(journalRowKey(prefix, 1), cells);
  const base: Cell[] = [
    ["event", "envelope", event],
    ["event", "has_snapshot", "1"],
  ];
  const write = (
    matched: boolean,
    rows: FakeStreamItem[],
    withHistory: Uint8Array | undefined = history,
  ) => {
    const bigtable = fakeBigtable({
      unary: () => ({ response: { predicateMatched: matched } }),
      stream: () => rows,
    });
    return {
      bigtable,
      done: writeJournalRow(
        tableOf(bigtable),
        prefix,
        1,
        event,
        withHistory,
        true,
      ),
    };
  };

  test("creates the row without reading it when it did not exist", async () => {
    const { bigtable, done } = write(false, []);
    await done;
    expect(bigtable.calls.map((c) => c.method)).toEqual(["checkAndMutateRow"]);
  });

  test.each([
    [
      "history already active and equal",
      [
        ...base,
        ["history", "state", "active"],
        ["history", "envelope", history],
      ] as Cell[],
      history,
    ],
    [
      "history already retired",
      [...base, ["history", "state", "retired"]] as Cell[],
      history,
    ],
    ["a row created before retention was set", base, history],
    ["no history requested", base, undefined],
  ])("accepts an existing row with %s", async (_name, cells, withHistory) => {
    await write(true, [row(cells)], withHistory).done;
  });

  test.each([
    ["a row that disappeared", [], history],
    [
      "a different event envelope",
      [
        row([
          ["event", "envelope", eventBytes(2)],
          ["event", "has_snapshot", "1"],
        ]),
      ],
      history,
    ],
    [
      "a different has_snapshot flag",
      [
        row([
          ["event", "envelope", event],
          ["event", "has_snapshot", "0"],
        ]),
      ],
      history,
    ],
    [
      "an unknown history state",
      [row([...base, ["history", "state", "weird"]])],
      history,
    ],
    [
      "a different history envelope",
      [
        row([
          ...base,
          ["history", "state", "active"],
          ["history", "envelope", snapshotBytes(5)],
        ]),
      ],
      history,
    ],
  ])("rejects %s as a storage error", async (_name, rows, withHistory) => {
    await expect(write(true, rows, withHistory).done).rejects.toMatchObject({
      type: "storage-error",
    });
  });
});

describe("retainBigtableHistory", () => {
  const stateRow = (seqNr: number, state: string) =>
    rowResponse(journalRowKey(prefix, seqNr), [["history", "state", state]]);
  const resources = (
    rows: FakeStreamItem[],
    hooks?: BigtableEventStoreHooks,
  ) => {
    const bigtable = fakeBigtable({
      unary: () => ({ response: { predicateMatched: true } }),
      stream: () => rows,
    });
    const journal = tableOf(bigtable);
    return {
      bigtable,
      resources: {
        settings: {},
        journal,
        head: journal,
        hooks,
      } as unknown as BigtableStoreResources<unknown, unknown>,
    };
  };

  test("retires only the active histories older than the newest keep, and leaves retired ones alone", async () => {
    const deletions: (readonly number[])[] = [];
    const { bigtable, resources: r } = resources(
      [stateRow(1, "retired"), stateRow(2, "active"), stateRow(3, "active")],
      { beforeRetentionDelete: (_aid, seqNrs) => void deletions.push(seqNrs) },
    );
    await retainBigtableHistory(r, AID, prefix, 3, 1);
    expect(deletions).toEqual([[2]]);
    expect(
      bigtable.calls.filter((c) => c.method === "checkAndMutateRow"),
    ).toHaveLength(1);
  });

  test("does nothing when nothing is older than keep", async () => {
    const { bigtable, resources: r } = resources([stateRow(3, "active")]);
    await retainBigtableHistory(r, AID, prefix, 3, 2);
    expect(bigtable.calls.map((c) => c.method)).toEqual(["readRows"]);
  });

  test("the listHistory hook replaces the visible histories", async () => {
    const { resources: r } = resources([stateRow(3, "active")], {
      listHistory: () => [1, 2, 3],
    });
    const seen: (readonly number[])[] = [];
    await retainBigtableHistory(
      {
        ...r,
        hooks: {
          listHistory: () => [1, 2, 3],
          beforeRetentionDelete: (_a, s) => void seen.push(s),
        },
      },
      AID,
      prefix,
      3,
      1,
    );
    expect(seen).toEqual([[2, 1]]);
  });

  test.each([
    [
      "a row key that is not a journal key",
      rowResponse(Buffer.concat([journalRowKey(prefix, 2), Buffer.from([0])]), [
        ["history", "state", "active"],
      ]),
    ],
    ["an unknown history state", stateRow(2, "weird")],
  ])("rejects %s as a storage error", async (_name, bad) => {
    const { resources: r } = resources([bad]);
    await expect(
      retainBigtableHistory(r, AID, prefix, 3, 1),
    ).rejects.toMatchObject({
      type: "storage-error",
    });
  });
});
