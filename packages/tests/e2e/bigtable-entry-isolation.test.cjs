const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const dist = fs.realpathSync(path.dirname(require.resolve("event-store-adapter-js")));
const SDK = "@google-cloud/bigtable";

// 入口から require で辿れるファイルを集める（相対 require だけを辿る）。
function reachableFiles(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const [, request] of source.matchAll(/require\("(\.[^"]+)"\)/g)) {
      queue.push(require.resolve(path.resolve(path.dirname(file), request)));
    }
  }
  return [...seen];
}
const namesSdk = (file) => fs.readFileSync(file, "utf8").includes(SDK);

for (const entry of ["index.js", "spanner.js", "sqlite.js"]) {
  test(`the built ${entry} reaches no file that names the Bigtable SDK`, () => {
    const files = reachableFiles(path.join(dist, entry));
    assert.ok(files.length > 0);
    assert.deepEqual(files.filter(namesSdk), []);
  });
}

test("the detector sees the SDK in a module that requires it", () => {
  // Bigtable の入口は呼び出し側のクライアントだけを使うので、SDK を要求しない。検出器は合成の module で確かめる。
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "eswa-bigtable-probe-"));
  try {
    const probe = path.join(directory, "probe.js");
    fs.writeFileSync(probe, `require("${SDK}");`);
    assert.ok(reachableFiles(probe).some((file) => new RegExp(`require\\("${SDK}"\\)`).test(fs.readFileSync(file, "utf8"))));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the built Bigtable entry reaches no file that names the SDK", () => {
  const files = reachableFiles(path.join(dist, "bigtable.js"));
  assert.ok(files.length > 1);
  assert.deepEqual(files.filter(namesSdk), []);
});

test("requiring the original, Spanner and SQLite entries in a child process never loads the Bigtable SDK", () => {
  for (const entry of ["event-store-adapter-js", "event-store-adapter-js/spanner", "event-store-adapter-js/sqlite"]) {
    const script = `
      const Module = require("node:module");
      const requested = [];
      const original = Module._load;
      Module._load = function (request, ...rest) { requested.push(request); return original.call(this, request, ...rest); };
      require(${JSON.stringify(entry)});
      process.stdout.write(JSON.stringify({ requested, cached: Object.keys(require.cache) }));
    `;
    const result = spawnSync(process.execPath, ["-e", script], { cwd: __dirname, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const { requested, cached } = JSON.parse(result.stdout);
    assert.deepEqual([...requested, ...cached].filter((name) => name.includes(SDK)), []);
  }
});
