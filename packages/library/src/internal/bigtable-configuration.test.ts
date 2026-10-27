import {
  parseConfigurationJson,
  renderConfigurationJson,
} from "./bigtable-configuration-json";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const STORE_ID = "5f0c8b8e-3c1a-4d7e-9a4b-2f6d1c0e7a11";

describe("configuration JSON", () => {
  test("does not count a quoted store_id inside a string as a top-level key, and reads keep count 2", () => {
    const record = parseConfigurationJson(
      bytes(
        `{"store_id":"${STORE_ID}","layout_version":1,"keep_snapshot_count":"2","retention_mode":"delete","envelope_limit_bytes":1048576,"note":"\\"store_id\\":1"}`,
      ),
    );
    expect(record).toEqual({
      storeId: STORE_ID,
      layoutVersion: 1,
      keepSnapshotCount: 2,
      retentionMode: "delete",
      envelopeLimitBytes: 1048576,
    });
  });

  test("reads a null keep count as no retention", () => {
    const record = parseConfigurationJson(
      bytes(
        `{"store_id":"${STORE_ID}","layout_version":1,"keep_snapshot_count":null,"retention_mode":"delete","envelope_limit_bytes":1048576}`,
      ),
    );
    expect(record.keepSnapshotCount).toBeNull();
  });

  const base = (over: string) =>
    `{${over},"layout_version":1,"retention_mode":"delete","envelope_limit_bytes":1048576}`;
  test.each([
    [
      "a duplicated top-level store_id",
      base(
        `"store_id":"${STORE_ID}","store_id":"${STORE_ID}","keep_snapshot_count":null`,
      ),
    ],
    [
      "a keep count with a leading zero",
      base(`"store_id":"${STORE_ID}","keep_snapshot_count":"02"`),
    ],
    [
      "a keep count written as a number",
      base(`"store_id":"${STORE_ID}","keep_snapshot_count":2`),
    ],
    [
      "a keep count in exponent form",
      base(`"store_id":"${STORE_ID}","keep_snapshot_count":"2e0"`),
    ],
    ["a missing store_id", base(`"keep_snapshot_count":null`)],
    ["text that is not JSON", "{"],
  ])("rejects %s as a configuration error", (_name, text) => {
    expect(() => parseConfigurationJson(bytes(text))).toThrow(
      expect.objectContaining({ type: "configuration-error" }),
    );
  });

  test("render then parse returns the same record, with the keep count as a decimal string", () => {
    const record = {
      storeId: STORE_ID,
      layoutVersion: 1,
      keepSnapshotCount: 3,
      retentionMode: "delete",
      envelopeLimitBytes: 2097152,
    };
    const rendered = renderConfigurationJson(record);
    expect(
      JSON.parse(Buffer.from(rendered).toString()).keep_snapshot_count,
    ).toBe("3");
    expect(parseConfigurationJson(rendered)).toEqual(record);
  });
});

describe("configuration JSON shape errors", () => {
  const valid = {
    store_id: STORE_ID,
    layout_version: 1,
    keep_snapshot_count: null,
    retention_mode: "delete",
    envelope_limit_bytes: 1048576,
  };
  test.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"x"'],
    [
      "a fractional layout_version",
      JSON.stringify({ ...valid, layout_version: 1.5 }),
    ],
    [
      "a layout_version that is not a number",
      JSON.stringify({ ...valid, layout_version: "1" }),
    ],
    [
      "a retention_mode that is not a string",
      JSON.stringify({ ...valid, retention_mode: 1 }),
    ],
    [
      "a negative envelope_limit_bytes",
      JSON.stringify({ ...valid, envelope_limit_bytes: -1 }),
    ],
    [
      "an envelope_limit_bytes that is not an integer",
      JSON.stringify({ ...valid, envelope_limit_bytes: 1.5 }),
    ],
    [
      "an envelope_limit_bytes that is a string",
      JSON.stringify({ ...valid, envelope_limit_bytes: "1" }),
    ],
    [
      "a keep_snapshot_count beyond the safe integers",
      JSON.stringify({ ...valid, keep_snapshot_count: "99999999999999999999" }),
    ],
  ])("rejects %s as a configuration error", (_name, text) => {
    expect(() => parseConfigurationJson(bytes(text))).toThrow(
      expect.objectContaining({ type: "configuration-error" }),
    );
  });

  test("rejects bytes that are not UTF-8", () => {
    expect(() => parseConfigurationJson(new Uint8Array([0xff, 0xfe]))).toThrow(
      expect.objectContaining({ type: "configuration-error" }),
    );
  });

  test("keys inside nested objects and arrays are not top-level keys", () => {
    const record = parseConfigurationJson(
      bytes(
        JSON.stringify({
          ...valid,
          nested: { store_id: 1, list: [{ store_id: 2 }, "a,b"] },
        }),
      ),
    );
    expect(record.storeId).toBe(STORE_ID);
  });
});
