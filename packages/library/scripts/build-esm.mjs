import { build } from "esbuild";
import { writeFile } from "node:fs/promises";

const workerBuild = await build({
  stdin: {
    contents:
      'import { parentPort } from "node:worker_threads"; import { serveSqliteWorkerRequests } from "./src/internal/sqlite-worker-requests"; if (parentPort === null) throw new Error("missing parent port"); serveSqliteWorkerRequests(parentPort);',
    resolveDir: process.cwd(),
    sourcefile: "sqlite-worker-entry.ts",
    loader: "ts",
  },
  bundle: true,
  external: ["node:*"],
  platform: "node",
  format: "cjs",
  target: "node24",
  write: false,
});
const workerSource = workerBuild.outputFiles[0].text;
const workerSourcePlugin = {
  name: "sqlite-worker-source",
  setup(build) {
    build.onResolve({ filter: /sqlite-worker-source$/ }, () => ({
      path: "sqlite-worker-source",
      namespace: "embedded-worker",
    }));
    build.onLoad(
      { filter: /.*/, namespace: "embedded-worker" },
      () => ({
        contents: `export const embeddedSqliteWorkerSource = ${JSON.stringify(workerSource)};`,
        loader: "js",
      }),
    );
  },
};

await build({
  entryPoints: ["src/index.ts", "src/spanner.ts", "src/sqlite.ts", "src/bigtable.ts"],
  outdir: "dist/esm",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  external: ["@aws-sdk/*", "@google-cloud/*", "node:*"],
  platform: "node",
  format: "esm",
  target: "node24",
  plugins: [workerSourcePlugin],
});

await Promise.all(
  ["index", "spanner", "sqlite", "bigtable"].map((entry) =>
    writeFile(`dist/esm/${entry}.d.mts`, `export * from "../${entry}.js";\n`),
  ),
);
