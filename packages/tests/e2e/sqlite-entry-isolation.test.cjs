const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const dist = fs.realpathSync(path.dirname(require.resolve("event-store-adapter-js")));

// dist/index.js から require で辿れるファイルを集める（相対 require だけを辿る）。
function reachableFiles(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const [, request] of source.matchAll(/require\("(\.[^"]+)"\)/g)) {
      const resolved = require.resolve(path.resolve(path.dirname(file), request));
      queue.push(resolved);
    }
  }
  return [...seen];
}

const mentionsNodeSqlite = (file) => /["']node:sqlite["']|["']sqlite["']/.test(fs.readFileSync(file, "utf8"));

test("the built original entry reaches no file that names node:sqlite", () => {
  const files = reachableFiles(path.join(dist, "index.js"));
  assert.ok(files.length > 1);
  assert.deepEqual(files.filter(mentionsNodeSqlite), []);
});

test("the built SQLite entry does reach a file that names node:sqlite (the detector can see it)", () => {
  const files = reachableFiles(path.join(dist, "sqlite.js"));
  assert.ok(files.some(mentionsNodeSqlite));
});

test("requiring the original entry in a child process never loads node:sqlite", () => {
  const script = `
    const Module = require("node:module");
    const requested = [];
    const original = Module._load;
    Module._load = function (request, ...rest) { requested.push(request); return original.call(this, request, ...rest); };
    require("event-store-adapter-js");
    process.stdout.write(JSON.stringify(requested));
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: __dirname, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).filter((name) => name === "node:sqlite" || name === "sqlite"), []);
});

test("the SQLite entry declares its types next to the runtime file", () => {
  assert.ok(fs.existsSync(path.join(dist, "sqlite.d.ts")));
  const declaration = fs.readFileSync(path.join(dist, "sqlite.d.ts"), "utf8");
  assert.match(declaration, /SqliteEventStore/);
  assert.match(declaration, /SqliteEventStoreInput/);
});
