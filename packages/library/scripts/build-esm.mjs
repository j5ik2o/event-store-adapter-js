import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts", "src/spanner.ts", "src/sqlite.ts", "src/bigtable.ts"],
  outdir: "dist/esm",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  external: ["@aws-sdk/*", "@google-cloud/*", "node:*"],
  platform: "node",
  format: "esm",
  target: "node24",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
