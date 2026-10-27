import { type ReadRowsOpener, readRows } from "./bigtable-read-rows";

const complete = (key: string, value: string) => ({
  chunks: [
    {
      rowKey: Buffer.from(key),
      familyName: { value: "event" },
      qualifier: { value: Buffer.from("envelope") },
      timestampMicros: 0,
      value: Buffer.from(value),
      valueSize: 0,
      resetRow: false,
      commitRow: true,
    },
  ],
});
const partial = (key: string) => ({
  chunks: [{ ...complete(key, "x").chunks[0], commitRow: false, valueSize: 9 }],
});
async function* stream(items: readonly object[], failAfter?: Error) {
  for (const item of items) yield item;
  if (failAfter !== undefined) throw failAfter;
}
const keys = (rows: readonly { key: Uint8Array }[]) =>
  rows.map((r) => Buffer.from(r.key).toString());

describe("readRows", () => {
  test("returns all rows of a stream that ends normally", async () => {
    const open: ReadRowsOpener = () =>
      stream([complete("a", "1"), complete("b", "2")]);
    expect(keys(await readRows(open))).toEqual(["a", "b"]);
  });

  test("resumes after the last completed row when the stream breaks mid-row, and drops the partial row", async () => {
    const resumes: (Uint8Array | undefined)[] = [];
    const attempts = [
      () =>
        stream([complete("a", "1"), partial("b")], new Error("unavailable")),
      () => stream([complete("b", "2"), complete("c", "3")]),
    ];
    const open: ReadRowsOpener = (resumeAfter) => {
      resumes.push(resumeAfter);
      const attempt = attempts.shift();
      if (attempt === undefined) throw new Error("no more attempts");
      return attempt();
    };
    expect(keys(await readRows(open))).toEqual(["a", "b", "c"]);
    expect(
      resumes.map((r) =>
        r === undefined ? undefined : Buffer.from(r).toString(),
      ),
    ).toEqual([undefined, "a"]);
  });

  test("fails with a storage error when an interrupted request completed no row, instead of retrying forever", async () => {
    let opens = 0;
    const open: ReadRowsOpener = () => {
      opens += 1;
      return stream([partial("a")], new Error("unavailable"));
    };
    await expect(readRows(open)).rejects.toMatchObject({
      type: "storage-error",
    });
    expect(opens).toBe(1);
  });

  test("fails with a storage error when the stream ends normally with an incomplete row", async () => {
    const open: ReadRowsOpener = () =>
      stream([complete("a", "1"), partial("b")]);
    await expect(readRows(open)).rejects.toMatchObject({
      type: "storage-error",
    });
  });
});

describe("readRows edge cases", () => {
  test("a response without chunks adds nothing", async () => {
    const open: ReadRowsOpener = () =>
      stream([{}, { chunks: null }, complete("a", "1")]);
    expect(keys(await readRows(open))).toEqual(["a"]);
  });

  test("a malformed response is a storage error and is not resumed", async () => {
    let opens = 0;
    const open: ReadRowsOpener = () => {
      opens += 1;
      return stream([complete("a", "1"), { chunks: [{ commitRow: true }] }]);
    };
    await expect(readRows(open)).rejects.toMatchObject({
      type: "storage-error",
    });
    expect(opens).toBe(1);
  });
});
