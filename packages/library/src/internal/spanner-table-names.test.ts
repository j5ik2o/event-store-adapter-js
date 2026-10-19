import { spannerTableNames } from "./spanner-table-names";

test("derives the five table names from the prefix", () => {
  expect(spannerTableNames("esa")).toEqual({
    type: "ok",
    value: {
      journal: "esa_journal",
      head: "esa_head",
      snapshotCurrent: "esa_snapshot_current",
      snapshotHistory: "esa_snapshot_history",
      config: "esa_config",
    },
  });
});

test.each(["1esa", "es`a", "es-a", "es a", "", "a".repeat(200)])(
  "rejects the prefix %p that cannot form a SQL identifier",
  (prefix) => {
    expect(spannerTableNames(prefix)).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "tablePrefix" },
    });
  },
);

test.each([undefined, null, 1, {}])(
  "rejects the non-string prefix %p",
  (prefix) => {
    expect(spannerTableNames(prefix)).toMatchObject({
      type: "err",
      error: { type: "configuration-error", fieldName: "tablePrefix" },
    });
  },
);
