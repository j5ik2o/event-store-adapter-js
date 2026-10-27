import * as fs from "node:fs";
import * as path from "node:path";

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
) as {
  exports: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
};
const SDK = "@google-cloud/bigtable";

test("exposes the ./bigtable entry next to the other entries", () => {
  expect(pkg.exports["."]).toBeDefined();
  expect(pkg.exports["./spanner"]).toBeDefined();
  expect(pkg.exports["./sqlite"]).toBeDefined();
  expect(pkg.exports["./bigtable"]).toEqual({
    types: "./dist/bigtable.d.ts",
    require: "./dist/bigtable.js",
    default: "./dist/bigtable.js",
  });
});

test("declares the SDK as an optional peer dependency (^7.5.0) and a dev dependency", () => {
  expect(pkg.peerDependencies?.[SDK]).toMatch(/\^7\.5\.0/);
  expect(pkg.peerDependenciesMeta?.[SDK]).toEqual({ optional: true });
  expect(pkg.devDependencies?.[SDK]).toBeDefined();
});

test("does not make the SDK a regular dependency", () => {
  expect(pkg.dependencies?.[SDK]).toBeUndefined();
});
