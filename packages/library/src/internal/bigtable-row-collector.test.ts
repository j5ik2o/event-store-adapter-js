import { cellValue } from "./bigtable-row";
import { RowCollector } from "./bigtable-row-collector";

type Chunk = {
  rowKey: Buffer | string;
  familyName: { value: string } | null;
  qualifier: { value: Buffer } | null;
  timestampMicros: number;
  value: Buffer;
  valueSize: number;
  resetRow: boolean;
  commitRow: boolean;
};

const chunk = (over: Partial<Chunk>): Chunk => ({
  rowKey: "",
  familyName: null,
  qualifier: null,
  timestampMicros: 0,
  value: Buffer.alloc(0),
  valueSize: 0,
  resetRow: false,
  commitRow: false,
  ...over,
});
const first = (
  key: string,
  family: string,
  qualifier: string,
  value: string,
  valueSize = 0,
) =>
  chunk({
    rowKey: Buffer.from(key),
    familyName: { value: family },
    qualifier: { value: Buffer.from(qualifier) },
    value: Buffer.from(value),
    valueSize,
  });

// 流れに乗る順にチャンクを渡し、完成した行を集める。
const collect = (chunks: readonly Chunk[]) => {
  const collector = new RowCollector();
  const rows = chunks.flatMap((c) => {
    const row = collector.push(c);
    return row === undefined ? [] : [row];
  });
  return { rows, partial: collector.hasPartialRow() };
};

describe("RowCollector", () => {
  test("joins a value split across chunks, keeps the family, and completes the row on commit", () => {
    const { rows, partial } = collect([
      first("r1", "event", "envelope", "ab", 4),
      chunk({ value: Buffer.from("cd"), commitRow: true }),
    ]);
    expect(partial).toBe(false);
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].key).toString()).toBe("r1");
    expect(
      Buffer.from(cellValue(rows[0], "event", "envelope") ?? []).toString(),
    ).toBe("abcd");
  });

  test("a following cell inherits the family and replaces the qualifier", () => {
    const { rows } = collect([
      first("r1", "event", "envelope", "x"),
      chunk({
        qualifier: { value: Buffer.from("has_snapshot") },
        value: Buffer.from("1"),
        commitRow: true,
      }),
    ]);
    expect(
      Buffer.from(cellValue(rows[0], "event", "has_snapshot") ?? []).toString(),
    ).toBe("1");
    expect(
      Buffer.from(cellValue(rows[0], "event", "envelope") ?? []).toString(),
    ).toBe("x");
  });

  test("treats a repeated identical row key inside a row as a continuation of that row", () => {
    const { rows } = collect([
      first("r1", "event", "envelope", "a"),
      chunk({
        rowKey: Buffer.from("r1"),
        qualifier: { value: Buffer.from("has_snapshot") },
        value: Buffer.from("0"),
        commitRow: true,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].cells).toHaveLength(2);
  });

  test("discards a row that the server reset and keeps only the re-read row", () => {
    const { rows } = collect([
      first("r1", "event", "envelope", "stale"),
      chunk({ resetRow: true }),
      { ...first("r1", "event", "envelope", "fresh"), commitRow: true },
    ]);
    expect(rows).toHaveLength(1);
    expect(
      Buffer.from(cellValue(rows[0], "event", "envelope") ?? []).toString(),
    ).toBe("fresh");
  });

  test("reports a partial row when the chunks end before the commit, without returning it", () => {
    const { rows, partial } = collect([
      first("r1", "event", "envelope", "a", 4),
    ]);
    expect(rows).toEqual([]);
    expect(partial).toBe(true);
  });

  test("returns several rows in stream order", () => {
    const { rows } = collect([
      { ...first("r1", "event", "envelope", "a"), commitRow: true },
      { ...first("r2", "event", "envelope", "b"), commitRow: true },
    ]);
    expect(rows.map((r) => Buffer.from(r.key).toString())).toEqual([
      "r1",
      "r2",
    ]);
  });

  test("cellValue returns undefined for a column the row lacks", () => {
    const { rows } = collect([
      { ...first("r1", "event", "envelope", "a"), commitRow: true },
    ]);
    expect(cellValue(rows[0], "history", "state")).toBeUndefined();
  });
});

describe("RowCollector structural errors and sparse chunks", () => {
  const push = (...chunks: object[]) => {
    const collector = new RowCollector();
    return chunks.map((c) => collector.push(c));
  };
  const structural = expect.objectContaining({ type: "storage-error" });

  test("a chunk that carries only the row status commits a row that has cells", () => {
    const rows = push(first("r1", "event", "envelope", "a"), {
      commitRow: true,
    });
    expect(rows[1]?.cells).toHaveLength(1);
  });

  test("tolerates chunks with every optional field absent or null", () => {
    const rows = push(
      {
        rowKey: Buffer.from("r1"),
        familyName: null,
        qualifier: null,
        timestampMicros: null,
        value: null,
        valueSize: null,
        resetRow: null,
        commitRow: null,
      },
      { commitRow: true },
    );
    expect(rows[0]).toBeUndefined();
    expect(rows[1]?.cells).toEqual([]);
  });

  test("an empty qualifier value after a family is a cell with an empty qualifier", () => {
    const rows = push(first("r1", "event", "envelope", "a"), {
      qualifier: { value: null },
      value: Buffer.from("b"),
      commitRow: true,
    });
    expect(rows[1]?.cells.map((c) => c.qualifier.length)).toEqual([8, 0]);
  });

  test("a family without a name is a cell before its column family", () => {
    expect(() =>
      push({ rowKey: Buffer.from("r1"), familyName: { value: null } }),
    ).toThrow(structural);
  });

  test("a different row key before the row is completed is an error", () => {
    expect(() =>
      push(
        first("r1", "event", "envelope", "a", 4),
        first("r2", "event", "envelope", "b"),
      ),
    ).toThrow(structural);
  });

  test("a chunk without a row key at the start of a row is an error", () => {
    expect(() => push(chunk({ commitRow: true }))).toThrow(structural);
  });

  test("a cell before its column family is an error", () => {
    expect(() =>
      push(chunk({ rowKey: Buffer.from("r1"), value: Buffer.from("x") })),
    ).toThrow(structural);
  });

  test("committing in the middle of a cell is an error", () => {
    expect(() =>
      push({ ...first("r1", "event", "envelope", "ab", 4), commitRow: true }),
    ).toThrow(structural);
  });

  test("a cell timestamp that is not zero marks a cell chunk", () => {
    const rows = push(
      chunk({
        rowKey: Buffer.from("r1"),
        familyName: { value: "event" },
        timestampMicros: "5" as never,
        commitRow: true,
      }),
    );
    expect(rows[0]?.cells[0].timestampMicros).toBe(5);
  });

  test("a reset chunk drops the partial row, so nothing is pending afterwards", () => {
    const collector = new RowCollector();
    collector.push(first("r1", "event", "envelope", "a", 4));
    expect(collector.hasPartialRow()).toBe(true);
    collector.push({ resetRow: true });
    expect(collector.hasPartialRow()).toBe(false);
  });
});
