import { declaredColumnCollation } from "./sqlite-column-collation";

const sql = (body: string): string => `CREATE TABLE t (${body}) STRICT`;

test.each([
  [
    "no COLLATE clause",
    sql("aid TEXT NOT NULL, seq_nr INTEGER, PRIMARY KEY (aid, seq_nr)"),
  ],
  [
    "an explicit lowercase binary",
    sql("aid TEXT COLLATE binary NOT NULL PRIMARY KEY"),
  ],
  [
    "a double-quoted column name",
    sql('"aid" TEXT COLLATE BINARY NOT NULL PRIMARY KEY'),
  ],
  [
    "a bracket-quoted column name",
    sql("[aid] TEXT COLLATE BINARY NOT NULL PRIMARY KEY"),
  ],
  ["a backtick-quoted column name", sql("`aid` TEXT NOT NULL PRIMARY KEY")],
])("reads BINARY from %s", (_, ddl) => {
  expect(declaredColumnCollation(ddl, "aid")?.toUpperCase()).toBe("BINARY");
});

test.each([
  ["NOCASE", sql("aid TEXT COLLATE NOCASE NOT NULL PRIMARY KEY"), "NOCASE"],
  ["RTRIM", sql("aid TEXT COLLATE RTRIM NOT NULL PRIMARY KEY"), "RTRIM"],
  [
    "the last COLLATE when several are written",
    sql("aid TEXT COLLATE NOCASE COLLATE BINARY NOT NULL"),
    "BINARY",
  ],
  [
    "a COLLATE written after NOT NULL",
    sql("aid TEXT NOT NULL COLLATE nocase PRIMARY KEY"),
    "NOCASE",
  ],
])("reads %s", (_, ddl, expected) => {
  expect(declaredColumnCollation(ddl, "aid")?.toUpperCase()).toBe(expected);
});

test("ignores COLLATE inside CHECK, string literals, block comments, and line comments", () => {
  const ddl = sql(
    "aid TEXT NOT NULL CHECK (aid COLLATE NOCASE = aid) DEFAULT 'COLLATE NOCASE' /* COLLATE NOCASE */ -- COLLATE RTRIM\n, seq_nr INTEGER",
  );
  expect(declaredColumnCollation(ddl, "aid")?.toUpperCase()).toBe("BINARY");
});

test("ignores COLLATE written on another column and in table constraints", () => {
  const ddl = sql(
    "aid TEXT NOT NULL, manifest TEXT COLLATE NOCASE NOT NULL, PRIMARY KEY (aid COLLATE NOCASE, manifest)",
  );
  expect(declaredColumnCollation(ddl, "aid")?.toUpperCase()).toBe("BINARY");
  expect(declaredColumnCollation(ddl, "manifest")?.toUpperCase()).toBe(
    "NOCASE",
  );
});

test("does not mistake a column whose name merely starts with the target name", () => {
  const ddl = sql("aid2 TEXT COLLATE NOCASE, aid TEXT NOT NULL");
  expect(declaredColumnCollation(ddl, "aid")?.toUpperCase()).toBe("BINARY");
});
