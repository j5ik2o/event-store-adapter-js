const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json")));
const peerRange = manifest.peerDependencies["@google-cloud/spanner"];
const protobufjsVersion = manifest.dependencies.protobufjs;
const matrix = [
  { version: "8.7.1", role: "minimum" },
  { version: "9.0.0", role: "minimum" },
  { version: "9.1.0", role: "representative" },
];

const parseVersion = (version) => {
  assert.match(version, /^\d+\.\d+\.\d+$/, `unsupported version ${version}`);
  return version.split(".").map(Number);
};
const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const caretBranches = (range) =>
  range.split("||").map((branch) => {
    const match = /^\^([1-9]\d*\.\d+\.\d+)$/.exec(branch.trim());
    if (!match) throw new Error(`unsupported peer range branch "${branch.trim()}" in "${range}"`);
    return parseVersion(match[1]);
  });
const checkMatrix = (range, entries) => {
  const branches = caretBranches(range);
  const minima = branches.map((branch) => branch.join(".")).sort();
  const listed = entries.filter((entry) => entry.role === "minimum").map((entry) => entry.version).sort();
  assert.deepEqual(listed, minima, `minimum cases must be exactly ${minima.join(", ")} for "${range}"`);
  for (const { version, role } of entries) {
    assert.ok(role === "minimum" || role === "representative", `unlabelled matrix entry ${version}`);
    const parsed = parseVersion(version);
    assert.ok(branches.some((branch) => parsed[0] === branch[0] && compareVersions(parsed, branch) >= 0), `${version} is outside "${range}"`);
  }
};

const assertWithin = (root, file) => {
  const relative = path.relative(root, file);
  assert.ok(relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative), `${file} is outside ${root}`);
};
const loadWithin = (root, file) => {
  assertWithin(root, file);
  return require(file);
};
const packageOf = (file, name) => {
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const manifestPath = path.join(dir, "package.json");
    const found = fs.existsSync(manifestPath) && JSON.parse(fs.readFileSync(manifestPath));
    if (found && found.name === name) return { path: file, version: found.version };
  }
  throw new Error(`no ${name} package above ${file}`);
};
const loadedModules = (transactionPath, retryWaitPath) => {
  const sdk = createRequire(transactionPath).resolve("@google-cloud/spanner");
  return {
    adapter: [transactionPath, retryWaitPath],
    sdk: packageOf(sdk, "@google-cloud/spanner"),
    grpc: packageOf(createRequire(sdk).resolve("@grpc/grpc-js"), "@grpc/grpc-js"),
    protobufjs: packageOf(createRequire(retryWaitPath).resolve("protobufjs/light"), "protobufjs"),
  };
};
const modulePaths = (modules) => [...modules.adapter, modules.sdk.path, modules.grpc.path, modules.protobufjs.path];

(async () => {
  checkMatrix(peerRange, matrix);
  for (const omitted of matrix.filter((entry) => entry.role === "minimum")) {
    assert.throws(() => checkMatrix(peerRange, matrix.filter((entry) => entry !== omitted)), /minimum cases must be exactly/);
  }
  assert.throws(() => checkMatrix(">=8.7.1", matrix), /unsupported peer range/);
  const workspace = loadedModules(require.resolve("../dist/internal/spanner-read-write-transaction"), require.resolve("../dist/internal/spanner-retry-wait"));
  for (const { version, role } of matrix) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `esa-retry-${version}-`));
    try {
      execFileSync("npm", ["install", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund", `@google-cloud/spanner@${version}`, `protobufjs@${protobufjsVersion}`], { stdio: "pipe" });
      fs.cpSync(path.join(__dirname, "../dist"), path.join(root, "dist"), { recursive: true });
      const isolated = fs.realpathSync(root);
      for (const file of modulePaths(workspace)) assert.throws(() => assertWithin(isolated, file), /is outside/);
      const local = createRequire(path.join(isolated, "package.json"));
      const transactionPath = local.resolve("./dist/internal/spanner-read-write-transaction");
      const retryWaitPath = local.resolve("./dist/internal/spanner-retry-wait");
      const modules = loadedModules(transactionPath, retryWaitPath);
      const { Metadata } = loadWithin(isolated, modules.grpc.path);
      const { Root } = loadWithin(isolated, modules.protobufjs.path);
      const descriptorPath = path.join(path.dirname(modules.sdk.path), version === "8.7.1" ? "../protos/protos.json" : "../protos/status.json");
      assertWithin(isolated, descriptorPath);
      const descriptor = JSON.parse(fs.readFileSync(descriptorPath));
      const info = Root.fromJSON(descriptor).lookupType("google.rpc.RetryInfo");
      const { runSpannerReadWriteTransaction: run } = loadWithin(isolated, transactionPath);
      const { decideRetryWait } = loadWithin(isolated, retryWaitPath);
      const encode = (duration) => Buffer.from(info.encode(info.fromObject({ retryDelay: duration })).finish());
      const makeCause = (values) => {
        const metadata = new Metadata();
        for (const value of values) metadata.add("google.rpc.retryinfo-bin", value);
        return Object.assign(new Error("aborted"), { code: 10, metadata });
      };
      let cases = 0;
      for (const [duration, expected] of [
        [{}, 1], [{ nanos: 1 }, 1], [{ nanos: 1000001 }, 2], [{ seconds: 1, nanos: 1 }, 1001],
        [{ seconds: "60" }, 60000], [{ seconds: 60, nanos: 1 }, "stop"],
        [{ seconds: "315576000000", nanos: 999999999 }, "stop"],
        [{ seconds: -1 }, 25], [{ nanos: -1 }, 25], [{ nanos: 1000000000 }, 25],
        [{ seconds: "315576000001" }, 25], [{ seconds: "9007199254740993" }, 25],
        [undefined, 25],
      ]) {
        const bytes = Buffer.concat([encode(duration), Buffer.from([0x98, 0x06, 1])]);
        const cause = makeCause([Buffer.from([10, 255]), bytes]);
        const decision = decideRetryWait(cause, 1, () => 0);
        assert.equal(expected === "stop" ? decision.kind : decision.milliseconds, expected);
        let acquired = 0;
        let now = 0;
        const waits = [];
        const order = [];
        const database = { getTransaction: async () => {
          acquired += 1;
          order.push("get");
          return [{ commit: async () => order.push("commit"), rollback: async () => order.push("rollback"), end: () => order.push("end") }];
        } };
        const result = await run(database, 1, async () => {
          order.push("body");
          if (acquired === 1) throw cause;
          return "done";
        }, { afterCommit: async () => order.push("after") }, {
          now: () => now, random: () => 0,
          sleep: async (ms) => { order.push("sleep"); waits.push(ms); now += ms; },
        });
        if (expected === "stop") {
          assert.equal(result.error.cause, cause);
          assert.match(result.error.message, /server retry delay/);
          assert.equal(acquired, 1);
          assert.deepEqual(waits, []);
        } else {
          assert.deepEqual(result, { type: "ok", value: "done" });
          assert.deepEqual(waits, [expected]);
          assert.deepEqual(order, ["get", "body", "rollback", "end", "sleep", "get", "body", "commit", "after", "end"]);
        }
        cases += 1;
      }
      for (const hex of ["0a020d3d", "0a02153d", "0a01083d", "083d", "0a002a03ff"]) {
        const malformed = Buffer.from(hex, "hex");
        const cause = makeCause([malformed, encode({ nanos: 1000001 })]);
        assert.deepEqual(decideRetryWait(cause, 1, () => 0), { kind: "server", milliseconds: 2 });
        assert.deepEqual(decideRetryWait(makeCause([malformed]), 1, () => 0), { kind: "fallback", milliseconds: 25 });
        let attempts = 0, now = 0;
        const waits = [];
        const result = await run({ getTransaction: async () => [{ commit: async () => {}, rollback: async () => {}, end() {} }] }, 1,
          async () => { if (++attempts === 1) throw cause; return "done"; }, undefined,
          { random: () => 0, now: () => now, sleep: async ms => { waits.push(ms); now += ms; } });
        assert.deepEqual(result, { type: "ok", value: "done" });
        assert.deepEqual(waits, [2]);
        assert.equal(attempts, 2);
        cases += 1;
      }
      const longFirst = makeCause([encode({ seconds: 61 }), encode({ nanos: 1 })]);
      assert.equal(decideRetryWait(longFirst, 1, () => { throw Error("random"); }).kind, "stop");
      for (const file of modulePaths(modules)) {
        assertWithin(isolated, file);
        assert.ok(require.cache[file], `${file} was not loaded`);
      }
      assert.equal(modules.sdk.version, version);
      assert.equal(modules.protobufjs.version, protobufjsVersion);
      console.log(JSON.stringify({ version, role, peerRange, node: process.version, modules, lockfileSha256: createHash("sha256").update(fs.readFileSync(path.join(root, "package-lock.json"))).digest("hex"), descriptorSha256: createHash("sha256").update(fs.readFileSync(descriptorPath)).digest("hex"), cases, firstValid: "PASS", entry: "PASS" }));
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
