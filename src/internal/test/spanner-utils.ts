import { type Database, Spanner } from "@google-cloud/spanner";
import type { StartedTestContainer } from "testcontainers";

const DEFAULT_PROJECT_ID = "test-project";
const SPANNER_EMULATOR_GRPC_PORT = 9010;

function createSpannerEventStoreSchema(
  journalTableName: string,
  snapshotTableName: string,
): string[] {
  return [
    `CREATE TABLE ${journalTableName} (
      shard_id INT64 NOT NULL,
      aggregate_id STRING(MAX) NOT NULL,
      sequence_number INT64 NOT NULL,
      payload BYTES(MAX) NOT NULL,
      occurred_at TIMESTAMP NOT NULL
    ) PRIMARY KEY (shard_id, aggregate_id, sequence_number)`,
    `CREATE TABLE ${snapshotTableName} (
      shard_id INT64 NOT NULL,
      aggregate_id STRING(MAX) NOT NULL,
      sequence_number INT64 NOT NULL,
      version INT64 NOT NULL,
      payload BYTES(MAX) NOT NULL,
      updated_at TIMESTAMP NOT NULL
    ) PRIMARY KEY (shard_id, aggregate_id, sequence_number)`,
  ];
}

async function createSpannerDatabase(input: {
  startedContainer: StartedTestContainer;
  instanceId: string;
  databaseId: string;
  journalTableName: string;
  snapshotTableName: string;
  projectId?: string;
}): Promise<{
  spanner: Spanner;
  database: Database;
  restoreEmulatorHost: () => void;
}> {
  const previousEmulatorHost = process.env.SPANNER_EMULATOR_HOST;
  process.env.SPANNER_EMULATOR_HOST = `localhost:${input.startedContainer.getMappedPort(
    SPANNER_EMULATOR_GRPC_PORT,
  )}`;
  const spanner = new Spanner({
    projectId: input.projectId ?? DEFAULT_PROJECT_ID,
  });
  const [instance, instanceOperation] = await spanner.createInstance(
    input.instanceId,
    {
      config: "emulator-config",
      nodes: 1,
      displayName: "Test Instance",
    },
  );
  await instanceOperation.promise();
  const [database, databaseOperation] = await instance.createDatabase(
    input.databaseId,
    {
      schema: createSpannerEventStoreSchema(
        input.journalTableName,
        input.snapshotTableName,
      ),
    },
  );
  await databaseOperation.promise();
  return {
    spanner,
    database,
    restoreEmulatorHost: () => {
      if (previousEmulatorHost === undefined) {
        delete process.env.SPANNER_EMULATOR_HOST;
        return;
      }
      process.env.SPANNER_EMULATOR_HOST = previousEmulatorHost;
    },
  };
}

export { createSpannerDatabase, createSpannerEventStoreSchema };
