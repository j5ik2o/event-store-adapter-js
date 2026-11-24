import { build } from "esbuild";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const entries = ["index", "spanner", "sqlite", "bigtable"];

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
  metafile: true,
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

const sharedRegistryPlugin = {
  name: "shared-cjs-registry",
  setup(build) {
    build.onResolve({ filter: /^\.\/shared-weak-map$/ }, () => ({
      // Native ESM must use the same registry as the tsc CommonJS entry.
      // Downstream bundlers can follow this statically without createRequire.
      path: "../internal/shared-weak-map.js",
      external: true,
    }));
  },
};

// Through 5.2.0, `import` resolved to CommonJS, where Node exposes
// module.exports as `default` and `"module.exports"`, and __esModule as a name.
// Each ESM entry keeps that namespace shape over its own bindings. The default
// object copies the property order and flags of the tsc CommonJS entry.
const compatibleEntryPlugin = {
  name: "commonjs-compatible-entry",
  setup(build) {
    build.onResolve({ filter: /^esm-entry:/ }, (args) => ({
      path: args.path.slice("esm-entry:".length),
      namespace: "esm-entry",
    }));
    build.onLoad({ filter: /.*/, namespace: "esm-entry" }, (args) => {
      const commonJs = require(path.resolve(`dist/${args.path}.js`));
      const bindings = Object.keys(commonJs).map((name) => {
        const { configurable } = Object.getOwnPropertyDescriptor(commonJs, name);
        return `Object.defineProperty(moduleExports, ${JSON.stringify(name)}, { enumerable: true, configurable: ${configurable}, get: () => entry[${JSON.stringify(name)}] });`;
      });
      return {
        contents: [
          `import * as entry from "./${args.path}";`,
          `export * from "./${args.path}";`,
          'const moduleExports = Object.defineProperty({}, "__esModule", { value: true });',
          ...bindings,
          'export { moduleExports as default, moduleExports as "module.exports" };',
          "export const __esModule = true;",
        ].join("\n"),
        resolveDir: path.resolve("src"),
        loader: "js",
      };
    });
  },
};

const esmBuild = await build({
  entryPoints: entries.map((entry) => ({ in: `esm-entry:${entry}`, out: entry })),
  outdir: "dist/esm",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  external: ["@aws-sdk/*", "@google-cloud/*", "node:*"],
  platform: "node",
  format: "esm",
  target: "node24",
  plugins: [compatibleEntryPlugin, workerSourcePlugin, sharedRegistryPlugin],
  metafile: true,
});

await Promise.all(
  entries.map((entry) =>
    writeFile(
      `dist/esm/${entry}.d.mts`,
      [
        `import * as entry from "../${entry}.js";`,
        `export * from "../${entry}.js";`,
        // The namespace keeps type-only exports reachable as `adapter.Type`.
        "export default entry;",
        "",
      ].join("\n"),
    ),
  ),
);

// Bundled packages come from the metafile; their license texts ship with them.
const bundledPackageRoot = (input) => {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  return match === null ? undefined : path.resolve(match[1]);
};
const bundledPackageRoots = (output) =>
  Object.keys(output.inputs).map(bundledPackageRoot).filter((root) => root !== undefined);
const bundles = entries.map((entry) => {
  const roots = bundledPackageRoots(esmBuild.metafile.outputs[`dist/esm/${entry}.mjs`]);
  // The SQLite worker is embedded in sqlite.mjs as source text.
  const embedded = entry === "sqlite" ? Object.values(workerBuild.metafile.outputs).flatMap(bundledPackageRoots) : [];
  return { entry, roots: [...new Set([...roots, ...embedded])] };
});
const licenseText = async (root) => {
  const file = (await readdir(root, { withFileTypes: true })).find(
    (dirent) => dirent.isFile() && /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(dirent.name),
  );
  if (file === undefined) throw new Error(`no license file in bundled package ${root}`);
  return readFile(path.join(root, file.name), "utf8");
};
const packages = await Promise.all(
  [...new Set(bundles.flatMap(({ roots }) => roots))].map(async (root) => {
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    return {
      root,
      id: `${manifest.name}@${manifest.version}`,
      license: manifest.license,
      text: await licenseText(root),
      files: bundles.filter(({ roots }) => roots.includes(root)).map(({ entry }) => `${entry}.mjs`),
    };
  }),
);
const sortedPackages = packages.toSorted((a, b) => a.id.localeCompare(b.id));
await writeFile(
  "dist/esm/THIRD_PARTY_LICENSES",
  [
    "Third-party packages bundled into the ESM files of event-store-adapter-js.\n",
    ...sortedPackages.map(({ id, license, text, files }) =>
      [`${"=".repeat(72)}`, id, `License: ${license}`, `Bundled into: ${files.join(", ")}`, "-".repeat(72), text.trimEnd(), ""].join("\n"),
    ),
  ].join("\n"),
);
await Promise.all(
  bundles
    .filter(({ roots }) => roots.length > 0)
    .map(async ({ entry, roots }) => {
      const file = `dist/esm/${entry}.mjs`;
      const ids = sortedPackages.filter(({ root }) => roots.includes(root)).map(({ id }) => id);
      const notice = `/*! Bundles ${ids.join(", ")}. See THIRD_PARTY_LICENSES next to this file for their licenses. */\n`;
      await writeFile(file, notice + (await readFile(file, "utf8")));
    }),
);
