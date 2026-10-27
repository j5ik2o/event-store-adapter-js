import * as fs from "node:fs";
import * as path from "node:path";

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
) as {
  exports: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  optionalDependencies?: Record<string, string>;
};

test("exposes the ./sqlite entry next to the original and Spanner entries", () => {
  expect(pkg.exports["."]).toBeDefined();
  expect(pkg.exports["./spanner"]).toBeDefined();
  expect(pkg.exports["./sqlite"]).toEqual({
    types: "./dist/sqlite.d.ts",
    require: "./dist/sqlite.js",
    default: "./dist/sqlite.js",
  });
});

test("does not add a SQLite driver to any dependency field", () => {
  const fields = [
    pkg.dependencies,
    pkg.peerDependencies,
    pkg.peerDependenciesMeta,
    pkg.optionalDependencies,
  ];
  for (const field of fields) {
    expect(
      Object.keys(field ?? {}).filter((name) => /sqlite/i.test(name)),
    ).toEqual([]);
  }
});
