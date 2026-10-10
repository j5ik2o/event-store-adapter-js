const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { withDynamoDB } = require("./dynamodb.cjs");

test("packed package type-checks and executes from an independent external project", { timeout: 240000 }, async () => {
  const libraryDirectory = path.resolve(__dirname, "../../library");
  const workspaceDirectory = fs.realpathSync(path.resolve(libraryDirectory, "../.."));
  const directory = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "eswa-public-"));
  assert.ok(!directory.startsWith(`${workspaceDirectory}${path.sep}`), "external project must be outside the workspace");
  const evidence = [];
  const run = (command, args, cwd, env = process.env) => {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120000 });
    evidence.push({ command, args, cwd, status: result.status, stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  try {
    run("pnpm", ["pack", "--pack-destination", directory], libraryDirectory);
    const archive = path.join(directory, fs.readdirSync(directory).find((file) => file.endsWith(".tgz")));
    const files = run("tar", ["-tzf", archive], directory).trim().split("\n");
    assert.ok(files.includes("package/dist/index.js"));
    assert.ok(!files.some((file) => /\/internal\/test\/|\.test\.(js|d\.ts)$/.test(file)));
    assert.ok(!files.some((file) => /\/next\/|spanner|shard-|default-serializer|\/dist\/(aggregate|event|types|event-serializer|snapshot-serializer)\.(js|d\.ts)$/.test(file)));
    const nodeVersion = require("@types/node/package.json").version;
    const sdkVersion = require("@aws-sdk/client-dynamodb/package.json").version;
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      private: true, dependencies: { "event-store-adapter-js": `file:${archive}`, "@types/node": nodeVersion, "@aws-sdk/client-dynamodb": sdkVersion },
    }));
    fs.copyFileSync(path.resolve(__dirname, "../fixtures/consume.cjs"), path.join(directory, "consume.cjs"));
    fs.copyFileSync(path.resolve(__dirname, "../fixtures/consume.ts"), path.join(directory, "consume.ts"));
    fs.writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, module: "Node16", moduleResolution: "Node16", target: "es2022", skipLibCheck: false, types: ["node"] },
      include: ["consume.ts"],
    }));
    const store = run("pnpm", ["store", "path"], libraryDirectory).trim();
    run("pnpm", ["install", "--ignore-scripts", "--store-dir", store, "--state-dir", path.join(directory, "state")], directory);
    run(process.execPath, [require.resolve("typescript/bin/tsc"), "--project", path.join(directory, "tsconfig.json")], directory);
    await withDynamoDB(async (layout) => {
      run(process.execPath, [path.join(directory, "consume.cjs")], directory, { ...process.env, ESWA_DYNAMODB_LAYOUT: JSON.stringify(layout) });
    });
    const output = process.env.PUBLIC_PACKAGE_REPORT_DIR;
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      fs.copyFileSync(archive, path.join(output, path.basename(archive)));
      fs.writeFileSync(path.join(output, "external.json"), JSON.stringify({ archive: path.basename(archive), sha256: createHash("sha256").update(fs.readFileSync(archive)).digest("hex"), files, evidence }, null, 2));
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
