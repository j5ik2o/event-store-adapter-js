import { type Database, type Instance, Spanner } from "@google-cloud/spanner";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";

const DEFAULT_PROJECT_ID = "test-project";
const SPANNER_EMULATOR_GRPC_PORT = 9010;
const SPANNER_EMULATOR_REST_PORT = 9020;

async function startSpannerContainer(input: {
  instanceId: string;
  databaseId: string;
  journalTableName: string;
  snapshotTableName: string;
}): Promise<{
  database: Database;
  stop: () => Promise<void>;
}> {
  const container = new GenericContainer(
    "gcr.io/cloud-spanner-emulator/emulator",
  )
    .withExposedPorts(SPANNER_EMULATOR_GRPC_PORT, SPANNER_EMULATOR_REST_PORT)
    .withWaitStrategy(Wait.forLogMessage("gRPC server listening"));
  const startedContainer = await container.start();
  let context: Awaited<ReturnType<typeof createSpannerDatabase>>;
  try {
    context = await createSpannerDatabase({
      startedContainer,
      ...input,
    });
  } catch (error) {
    // createSpannerDatabase closes its Spanner client and restores env on failure.
    try {
      await startedContainer.stop();
    } catch (stopError) {
      console.warn("Failed to stop Spanner emulator container", stopError);
    }
    throw error;
  }
  return {
    database: context.database,
    stop: async () => {
      try {
        await context.database.close();
        context.spanner.close();
      } finally {
        context.restoreEmulatorHost();
        await startedContainer.stop();
      }
    },
  };
}

async function createSpannerDatabase(input: {
  startedContainer: StartedTestContainer;
  instanceId: string;
  databaseId: string;
  journalTableName: string;
  snapshotTableName: string;
}): Promise<{
  spanner: Spanner;
  database: Database;
  restoreEmulatorHost: () => void;
}> {
  const previousEmulatorHost = process.env.SPANNER_EMULATOR_HOST;
  const previousGoogleCloudProject = process.env.GOOGLE_CLOUD_PROJECT;
  const previousGcloudProject = process.env.GCLOUD_PROJECT;
  const previousMetadataServerDetection = process.env.METADATA_SERVER_DETECTION;
  process.env.SPANNER_EMULATOR_HOST = `localhost:${input.startedContainer.getMappedPort(
    SPANNER_EMULATOR_GRPC_PORT,
  )}`;
  process.env.GOOGLE_CLOUD_PROJECT = DEFAULT_PROJECT_ID;
  process.env.GCLOUD_PROJECT = DEFAULT_PROJECT_ID;
  process.env.METADATA_SERVER_DETECTION = "none";
  const spanner = new Spanner({ projectId: DEFAULT_PROJECT_ID });
  let createdInstance: Instance | undefined;
  let createdDatabase: Database | undefined;
  const restoreEmulatorHost = () => {
    restoreEnvValue("SPANNER_EMULATOR_HOST", previousEmulatorHost);
    restoreEnvValue("GOOGLE_CLOUD_PROJECT", previousGoogleCloudProject);
    restoreEnvValue("GCLOUD_PROJECT", previousGcloudProject);
    restoreEnvValue(
      "METADATA_SERVER_DETECTION",
      previousMetadataServerDetection,
    );
  };
  try {
    const [instance, instanceOperation] = await spanner.createInstance(
      input.instanceId,
      {
        config: "emulator-config",
        nodes: 1,
        displayName: "Example Instance",
      },
    );
    createdInstance = instance;
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
    createdDatabase = database;
    await databaseOperation.promise();
    return {
      spanner,
      database,
      restoreEmulatorHost,
    };
  } catch (error) {
    if (createdDatabase !== undefined) {
      try {
        await createdDatabase.close();
      } catch (closeError) {
        console.warn("Failed to close Spanner emulator database", closeError);
      }
    }
    if (createdInstance !== undefined) {
      try {
        await createdInstance.delete();
      } catch (deleteError) {
        console.warn("Failed to delete Spanner emulator instance", deleteError);
      }
    }
    restoreEmulatorHost();
    // Close the client created in this function before the caller stops the container.
    spanner.close();
    throw error;
  }
}

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

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

export { startSpannerContainer };
