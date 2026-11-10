const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");

(async () => {
  for (const version of ["8.7.1", "9.0.0", "9.1.0"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `esa-retry-${version}-`));
    execFileSync("npm", ["install", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund", `@google-cloud/spanner@${version}`, "protobufjs@7.6.6"], { stdio: "pipe" });
    fs.cpSync(path.join(__dirname, "../dist"), path.join(root, "dist"), { recursive: true });
    const local = createRequire(path.join(root, "package.json"));
    const sdk = local.resolve("@google-cloud/spanner");
    const sdkRequire = createRequire(sdk);
    const { Metadata } = sdkRequire("@grpc/grpc-js");
    const { Root } = local("protobufjs/light");
    const descriptorPath = path.join(path.dirname(sdk), version === "8.7.1" ? "../protos/protos.json" : "../protos/status.json");
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath));
    const info = Root.fromJSON(descriptor).lookupType("google.rpc.RetryInfo");
    const { runSpannerReadWriteTransaction: run } = local("./dist/internal/spanner-read-write-transaction");
    const { decideRetryWait } = local("./dist/internal/spanner-retry-wait");
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
    console.log(JSON.stringify({ version, resolved: sdk, descriptorSha256: createHash("sha256").update(fs.readFileSync(descriptorPath)).digest("hex"), cases, firstValid: "PASS", entry: "PASS" }));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
