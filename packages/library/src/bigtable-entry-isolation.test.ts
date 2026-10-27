import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const packageRoot = path.resolve(__dirname, "..");
const tsc = require.resolve("typescript/bin/tsc");
const SDK = "@google-cloud/bigtable";

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
    const cached = Object.keys(require.cache);
    process.stdout.write(JSON.stringify({ requested, cached }));
  `;
  const out = JSON.parse(
    execFileSync(process.execPath, ["-e", script, entry], {
      cwd: packageRoot,
      encoding: "utf8",
    }),
  ) as { requested: string[]; cached: string[] };
  return [
    ...out.requested,
    ...out.cached.filter((file) => file.includes("@google-cloud")),
  ];
};

describe("the original entry does not load the Bigtable SDK", () => {
  let outDir = "";
  beforeAll(() => {
    // 出力先はパッケージの node_modules の下に置く。子プロセスの require が、
    // 読み込むファイルの場所から上へ node_modules を探して依存を解決できるようにする。
    const cache = path.join(packageRoot, "node_modules", ".cache");
    mkdirSync(cache, { recursive: true });
    outDir = mkdtempSync(path.join(cache, "entry-isolation-"));
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

  test.each(["index.js", "spanner.js", "sqlite.js"])(
    "loading dist/%s never requests or caches @google-cloud/bigtable",
    (file) => {
      const loaded = loadedRequests(path.join(outDir, file));
      expect(loaded.filter((name) => name.includes(SDK))).toEqual([]);
    },
  );

  test("the detector sees the SDK when a module that requires it is loaded", () => {
    // Bigtable の入口は、呼び出し側が渡すクライアントだけを使うので、読み込み時に SDK を要求しない。
    // 検出器が働くことは、SDK を要求する合成の module で確かめる。
    const probe = path.join(outDir, "sdk-probe.js");
    writeFileSync(probe, `require(${JSON.stringify(SDK)});`);
    const loaded = loadedRequests(probe);
    expect(loaded.some((name) => name.includes(SDK))).toBe(true);
  });

  test("the Bigtable entry loads without the SDK and exposes only BigtableEventStore", () => {
    const loaded = loadedRequests(path.join(outDir, "bigtable.js"));
    expect(loaded.filter((name) => name.includes(SDK))).toEqual([]);
  });
});
