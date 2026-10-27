import { BigtableEventStore } from "../bigtable-event-store";
import {
  encodeEventEnvelope,
  encodeSnapshotEnvelope,
} from "./bigtable-envelope";
import { initializeBigtableStoreInternal } from "./bigtable-event-store";
import { fnv1a64 } from "./fnv1a64";
import { BigtableEmulator } from "./test/bigtable-emulator";
import {
  eventOf,
  FAMILY,
  headSeqNrBytes,
  id,
  unwrap,
} from "./test/bigtable-fixture";

let emulator: BigtableEmulator;
beforeAll(async () => {
  emulator = await BigtableEmulator.start();
}, 300000);
afterAll(async () => {
  await emulator.stop();
}, 60000);

const utf8 = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));
// Rust 版の手順書にある行キーを、js のコードを使わずに組み立てる。
const rustPrefix = (aid: string): Buffer => {
  const hash = Buffer.alloc(8);
  hash.writeBigUInt64BE(fnv1a64(aid));
  const length = Buffer.alloc(2);
  length.writeUInt16BE(Buffer.byteLength(aid));
  return Buffer.concat([hash, length, Buffer.from(aid)]);
};
const rustJournalKey = (aid: string, seqNr: number): Buffer => {
  const n = Buffer.alloc(8);
  n.writeBigUInt64BE(BigInt(seqNr));
  return Buffer.concat([rustPrefix(aid), n]);
};

describe("rows written in the Rust (v5) layout (acceptance 4)", () => {
  test("js reads the events and the snapshot that raw Rust-shaped cells hold", async () => {
    const tables = await emulator.createTables();
    const input = {
      bigtable: emulator.bigtable,
      instanceId: emulator.instanceId,
      tables,
    };
    unwrap(await initializeBigtableStoreInternal(input));
    const aid = "Order-r1";
    const event = (seqNr: number) =>
      Buffer.from(
        encodeEventEnvelope({
          aid,
          seqNr,
          occurredAtNs: BigInt("1791504000123000000"),
          manifest: "event/v1",
          payload: utf8({ seqNr }),
        }),
      );
    await emulator.writeCell(
      tables.journal,
      rustJournalKey(aid, 1),
      FAMILY.event,
      "envelope",
      event(1),
    );
    await emulator.writeCell(
      tables.journal,
      rustJournalKey(aid, 1),
      FAMILY.event,
      "has_snapshot",
      Buffer.from("0"),
    );
    await emulator.writeCell(
      tables.head,
      rustPrefix(aid),
      FAMILY.head,
      "seq_nr",
      headSeqNrBytes(2),
    );
    await emulator.writeCell(
      tables.head,
      rustPrefix(aid),
      FAMILY.head,
      "last_event",
      event(2),
    );
    await emulator.writeCell(
      tables.head,
      rustPrefix(aid),
      FAMILY.head,
      "has_snapshot",
      Buffer.from("1"),
    );
    await emulator.writeCell(
      tables.head,
      rustPrefix(aid),
      FAMILY.snapshot,
      "current",
      Buffer.from(
        encodeSnapshotEnvelope({
          seqNr: 2,
          manifest: "snapshot/v1",
          payload: utf8({ total: 2 }),
        }),
      ),
    );
    const store = unwrap(await BigtableEventStore.create(input));
    const events = unwrap(await store.getEventsByIdSinceSeqNr(id("r1"), 1));
    expect(events.map((e) => e.seqNr)).toEqual([1, 2]);
    expect(events[1].payload).toEqual({ seqNr: 2 });
    expect(
      unwrap(await store.getLatestSnapshotById(id("r1")))?.snapshot?.aggregate,
    ).toEqual({ total: 2 });
  });

  test("the rows js writes sit at the Rust keys with the Rust cell names and envelope bytes", async () => {
    const tables = await emulator.createTables();
    const input = {
      bigtable: emulator.bigtable,
      instanceId: emulator.instanceId,
      tables,
    };
    unwrap(await initializeBigtableStoreInternal(input));
    const store = unwrap(await BigtableEventStore.create(input));
    unwrap(await store.persistEvent(eventOf("r2", 1)));
    unwrap(await store.persistEvent(eventOf("r2", 2)));
    const aid = "Order-r2";
    const head = await emulator.readRow(tables.head, rustPrefix(aid));
    expect(
      head?.[FAMILY.head]?.seq_nr?.[0].value.equals(headSeqNrBytes(2)),
    ).toBe(true);
    const expectedTail = Buffer.from(
      encodeEventEnvelope({
        aid,
        seqNr: 2,
        occurredAtNs:
          BigInt(Date.parse("2026-10-09T00:00:00.123Z")) * BigInt(1_000_000),
        manifest: "event/v1",
        payload: utf8({ seqNr: 2 }),
      }),
    );
    expect(
      head?.[FAMILY.head]?.last_event?.[0].value.equals(expectedTail),
    ).toBe(true);
    const journal = await emulator.readRow(
      tables.journal,
      rustJournalKey(aid, 1),
    );
    expect(journal?.[FAMILY.event]?.envelope).toHaveLength(1);
    expect(journal?.[FAMILY.event]?.has_snapshot?.[0].value.toString()).toBe(
      "0",
    );
  });
});
