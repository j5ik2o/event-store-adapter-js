import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";

const packageRoot = path.resolve(__dirname, "..");
const tsc = require.resolve("typescript/bin/tsc");

// 子プロセスで入口を読み込み、読み込んだ module の要求名を JSON で返す。
const loadedRequests = (entry: string): readonly string[] => {
  const script = `
    const Module = require("node:module");
    const requested = [];
    const original = Module._load;
    Module._load = function (request, ...rest) {
      requested.push(request);
      return original.call(this, request, ...rest);
    };
    require(process.argv[1]);
    process.stdout.write(JSON.stringify(requested));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["-e", script, entry], {
      cwd: packageRoot,
      encoding: "utf8",
    }),
  ) as string[];
};

const isSqliteBuiltin = (name: string): boolean =>
  name === "node:sqlite" || name === "sqlite";

describe("the original and Spanner entries do not load node:sqlite", () => {
  let outDir = "";
  beforeAll(() => {
    const cache = path.join(packageRoot, "node_modules", ".cache");
    mkdirSync(cache, { recursive: true });
    outDir = mkdtempSync(path.join(cache, "sqlite-entry-isolation-"));
    execFileSync(
      process.execPath,
      [
        tsc,
        "-p",
        path.join(packageRoot, "tsconfig.json"),
        "--outDir",
        outDir,
        "--rootDir",
        path.join(packageRoot, "src"),
      ],
      { cwd: packageRoot, stdio: "pipe" },
    );
  }, 240000);
  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  test("loading dist/index.js never requests node:sqlite", () => {
    const loaded = loadedRequests(path.join(outDir, "index.js"));
    expect(loaded.filter(isSqliteBuiltin)).toEqual([]);
  });

  test("loading dist/spanner.js never requests node:sqlite", () => {
    const loaded = loadedRequests(path.join(outDir, "spanner.js"));
    expect(loaded.filter(isSqliteBuiltin)).toEqual([]);
  });

  test("loading the SQLite entry does request node:sqlite (the detector can see it)", () => {
    const loaded = loadedRequests(path.join(outDir, "sqlite.js"));
    expect(loaded.some(isSqliteBuiltin)).toBe(true);
  });
});
