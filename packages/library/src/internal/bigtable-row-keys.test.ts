import {
  aggregatePrefix,
  CONFIG_ROW_KEY,
  journalRange,
  journalRowKey,
  journalSeqNr,
} from "./bigtable-row-keys";
import { fnv1a64 } from "./fnv1a64";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("row keys", () => {
  test("the journal key of aid Order-9 at seq_nr 256 is H, L16, the UTF-8 aid and U64BE", () => {
    const aid = "Order-9";
    const key = journalRowKey(aggregatePrefix(aid), 256);
    const expected =
      fnv1a64(aid).toString(16).padStart(16, "0") +
      "0007" +
      Buffer.from(aid, "utf8").toString("hex") +
      "0000000000000100";
    expect(hex(key)).toBe(expected);
  });

  test("the head key is the prefix itself and counts the aid length in UTF-8 bytes", () => {
    const aid = "注文-1";
    const prefix = aggregatePrefix(aid);
    expect(hex(prefix.subarray(8, 10))).toBe("0008");
    expect(prefix.length).toBe(8 + 2 + 8);
  });

  test("seq_nr is encoded big-endian so byte order equals numeric order, including 2^53-1", () => {
    const prefix = aggregatePrefix("a");
    const keys = [1, 2, 255, 256, 65536, Number.MAX_SAFE_INTEGER].map((n) =>
      Buffer.from(journalRowKey(prefix, n)),
    );
    const sorted = [...keys].sort(Buffer.compare);
    expect(sorted.map(hex)).toEqual(keys.map(hex));
    expect(hex(keys[5].subarray(-8))).toBe("001fffffffffffff");
  });

  test("a supplied hash replaces the FNV-1a 64 value in the first 8 bytes", () => {
    const prefix = aggregatePrefix("a-1", BigInt(0xabcdef));
    expect(hex(prefix.subarray(0, 8))).toBe("0000000000abcdef");
  });

  test("the journal range is [prefix+start, prefix+end) with an 8-byte end and no 0xff sentinel", () => {
    const prefix = aggregatePrefix("Order-9");
    const [start, end] = journalRange(prefix, 3, 7);
    expect(hex(start)).toBe(hex(journalRowKey(prefix, 3)));
    expect(hex(end)).toBe(hex(journalRowKey(prefix, 7)));
    expect(end.length).toBe(prefix.length + 8);
  });

  test("journalSeqNr reads the number back and rejects other keys", () => {
    const prefix = aggregatePrefix("a-1");
    expect(journalSeqNr(prefix, journalRowKey(prefix, 42))).toBe(42);
    expect(journalSeqNr(prefix, prefix)).toBeUndefined();
    expect(
      journalSeqNr(
        prefix,
        Buffer.concat([journalRowKey(prefix, 42), Buffer.from([0])]),
      ),
    ).toBeUndefined();
    expect(
      journalSeqNr(prefix, journalRowKey(aggregatePrefix("a-12"), 42)),
    ).toBeUndefined();
  });

  test("the prefix of an aid never prefixes the key of a different aid, even with a colliding hash", () => {
    const hash = BigInt(7);
    const short = aggregatePrefix("a-1", hash);
    for (const other of ["a-12", "a-1\u0000"]) {
      const key = aggregatePrefix(other, hash);
      expect(
        Buffer.from(key).subarray(0, short.length).equals(Buffer.from(short)),
      ).toBe(false);
    }
  });

  test("the config row key is the single byte 0x00 and is shorter than any data key", () => {
    expect(hex(CONFIG_ROW_KEY)).toBe("00");
    expect(aggregatePrefix("a").length).toBeGreaterThan(CONFIG_ROW_KEY.length);
    expect(
      Buffer.from(CONFIG_ROW_KEY).equals(Buffer.from(aggregatePrefix("a"))),
    ).toBe(false);
  });

  test("rejects decimal-string and 0xff-sentinel layouts: ranges use fixed 8-byte numbers", () => {
    const prefix = aggregatePrefix("Order-9");
    const nine = Buffer.from(journalRowKey(prefix, 9));
    const ten = Buffer.from(journalRowKey(prefix, 10));
    expect(Buffer.compare(nine, ten)).toBeLessThan(0);
  });
});

test("a key whose number exceeds 2^53-1 has no seq_nr", () => {
  const prefix = aggregatePrefix("a");
  const key = Buffer.concat([prefix, Buffer.from("0020000000000000", "hex")]);
  expect(journalSeqNr(prefix, key)).toBeUndefined();
});
