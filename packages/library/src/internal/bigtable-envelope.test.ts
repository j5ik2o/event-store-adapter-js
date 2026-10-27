import * as fs from "node:fs";
import * as path from "node:path";
import {
  decodeEventEnvelope,
  decodeSnapshotEnvelope,
  encodeEventEnvelope,
  encodeSnapshotEnvelope,
} from "./bigtable-envelope";

type ValueCase = {
  id: string;
  operation: string;
  input: Record<string, unknown>;
  expect: { value?: string; error?: unknown };
};
const cases = (
  JSON.parse(
    fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../../conformance/values/bigtable-envelope.json",
      ),
      "utf8",
    ),
  ).cases as ValueCase[]
).filter((c) => c.operation.includes("Bigtable"));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const fromHex = (text: string): Uint8Array => Buffer.from(text, "hex");

describe("envelope encoding matches the distributed value table", () => {
  const encodes = cases.filter((c) => c.expect.value !== undefined);
  test("the table holds the ten envelope cases", () => {
    expect(cases).toHaveLength(10);
  });
  test.each(encodes.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const input = c.input as {
      aid?: string;
      seq_nr: number;
      occurred_at_ns?: string;
      manifest: string;
      payload_hex: string;
    };
    const actual =
      c.operation === "encodeBigtableEventEnvelope"
        ? encodeEventEnvelope({
            aid: input.aid as string,
            seqNr: input.seq_nr,
            occurredAtNs: BigInt(input.occurred_at_ns as string),
            manifest: input.manifest,
            payload: fromHex(input.payload_hex),
          })
        : encodeSnapshotEnvelope({
            seqNr: input.seq_nr,
            manifest: input.manifest,
            payload: fromHex(input.payload_hex),
          });
    expect(hex(actual)).toBe(c.expect.value);
  });
});

const EMPTY_EVENT =
  "0100074f726465722d39000000000000000100000000000000000000000000000000";

describe("envelope decoding", () => {
  test("restores every field of an event envelope", () => {
    const decoded = decodeEventEnvelope(
      fromHex(
        "0100074f726465722d390000000000000002000000003b9aca000000000276310000000600010203feff",
      ),
    );
    expect(decoded).toEqual({
      aid: "Order-9",
      seqNr: 2,
      occurredAtNs: BigInt(1_000_000_000),
      manifest: "v1",
      payload: new Uint8Array([0, 1, 2, 3, 0xfe, 0xff]),
    });
  });

  test("restores a snapshot envelope", () => {
    const decoded = decodeSnapshotEnvelope(
      fromHex("01001fffffffffffff0000000ce382b9e3838ae38383e38397000000027b7d"),
    );
    expect(decoded.seqNr).toBe(Number.MAX_SAFE_INTEGER);
    expect(decoded.manifest).toBe("スナップ");
    expect(hex(decoded.payload)).toBe("7b7d");
  });

  test.each([
    ["a trailing unused byte", `${EMPTY_EVENT}00`],
    [
      "a payload length that does not match",
      "0100074f726465722d3900000000000000010000000000000000000000000000000500000000",
    ],
    ["an unknown format version", `02${EMPTY_EVENT.slice(2)}`],
    ["a truncated envelope", EMPTY_EVENT.slice(0, 20)],
    ["an empty value", ""],
  ])(
    "rejects %s as a storage error, not a serialization error",
    (_name, bytes) => {
      expect(() => decodeEventEnvelope(fromHex(bytes))).toThrow(
        expect.objectContaining({ type: "storage-error" }),
      );
    },
  );

  test("rejects a snapshot envelope with a trailing byte as a storage error", () => {
    expect(() =>
      decodeSnapshotEnvelope(fromHex("010000000000000001000000000000000000")),
    ).toThrow(expect.objectContaining({ type: "storage-error" }));
  });

  test("a seq_nr above 2^53-1 is a storage error", () => {
    const tooBig = `0100074f726465722d39${"0020000000000000"}00000000000000000000000000000000`;
    expect(() => decodeEventEnvelope(fromHex(tooBig))).toThrow(
      expect.objectContaining({ type: "storage-error" }),
    );
  });
});

test("a seq_nr of 0 is a storage error in both envelope kinds", () => {
  const zero = "0000000000000000";
  expect(() =>
    decodeEventEnvelope(
      fromHex(`0100074f726465722d39${zero}00000000000000000000000000000000`),
    ),
  ).toThrow(expect.objectContaining({ type: "storage-error" }));
  expect(() =>
    decodeSnapshotEnvelope(fromHex(`01${zero}0000000000000000`)),
  ).toThrow(expect.objectContaining({ type: "storage-error" }));
});

test("rejects text that is not UTF-8 as a storage error", () => {
  // aid の長さ 1 の位置に、UTF-8 として不正な 1 バイトを置く。
  const bytes = fromHex(
    "0100" +
      "01" +
      "ff" +
      "0000000000000001" +
      "0000000000000000" +
      "00000000" +
      "00000000",
  );
  expect(() => decodeEventEnvelope(bytes)).toThrow(
    expect.objectContaining({ type: "storage-error" }),
  );
});
