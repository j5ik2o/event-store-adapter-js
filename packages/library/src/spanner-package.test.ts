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
const SDK = "@google-cloud/spanner";

test("exposes the ./spanner entry next to the original entry", () => {
  expect(pkg.exports["."]).toBeDefined();
  expect(pkg.exports["./spanner"]).toEqual({
    types: "./dist/spanner.d.ts",
    require: "./dist/spanner.js",
    default: "./dist/spanner.js",
  });
});

test("declares the SDK as an optional peer dependency and a dev dependency", () => {
  expect(pkg.peerDependencies?.[SDK]).toMatch(/^\^8\.7\.1 \|\| \^9\.0\.0/);
  expect(pkg.peerDependenciesMeta?.[SDK]).toEqual({ optional: true });
  expect(pkg.devDependencies?.[SDK]).toBeDefined();
});

test("does not make the SDK a regular dependency", () => {
  expect(pkg.dependencies?.[SDK]).toBeUndefined();
});
