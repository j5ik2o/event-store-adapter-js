const { randomUUID } = require("node:crypto");
const { Bigtable } = require("@google-cloud/bigtable");
const { GenericContainer, Wait } = require("testcontainers");

// Rust 版と同じイメージをダイジェストで固定して使う。実サービスには接続しない。
const IMAGE = "gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:8d8573471c489a409f03891d2c24d177fa531276184f7002b9a2d853d1b3ed54";
const INSTANCE = "test-instance";

async function withBigtable(run) {
  const container = await new GenericContainer(IMAGE)
    .withCommand(["gcloud", "beta", "emulators", "bigtable", "start", "--host-port=0.0.0.0:8086"])
    .withExposedPorts(8086).withWaitStrategy(Wait.forLogMessage(/Cloud Bigtable emulator running/)).withStartupTimeout(180000).start();
  const apiEndpoint = `${container.getHost()}:${container.getMappedPort(8086)}`;
  const bigtable = new Bigtable({ projectId: "test-project", apiEndpoint, metricsEnabled: false });
  try {
    const prefix = `package-${randomUUID().slice(0, 8)}`;
    const tables = { journal: `${prefix}-journal`, head: `${prefix}-head` };
    const instance = bigtable.instance(INSTANCE);
    const rule = { versions: 1 };
    await instance.createTable(tables.journal, { families: [{ name: "event", rule }, { name: "history", rule }, { name: "config" }] });
    await instance.createTable(tables.head, { families: [{ name: "head", rule }, { name: "snapshot", rule }, { name: "config" }] });
    return await run({ projectId: "test-project", apiEndpoint, instanceId: INSTANCE, tables });
  } finally {
    bigtable.close();
    await container.stop();
  }
}

module.exports = { withBigtable };
