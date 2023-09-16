import {
  TestContainer,
  StartedTestContainer,
  GenericContainer,
  Wait,
} from "testcontainers";
import { describe } from "node:test";

describe("EventStoreForDynamoDB", () => {
  let container: TestContainer;
  let startedContainer: StartedTestContainer;

  beforeAll(async () => {
    container = new GenericContainer("localstack/localstack:2.1.0")
      .withEnvironment({
        SERVICES: "dynamodb",
        DEFAULT_REGION: "us-west-1",
        EAGER_SERVICE_LOADING: "1",
        DYNAMODB_SHARED_DB: "1",
        DYNAMODB_IN_MEMORY: "1",
      })
      .withWaitStrategy(Wait.forLogMessage("Ready."))
      .withExposedPorts(4566);
    startedContainer = await container.start();
  });

  afterAll(async () => {
    await startedContainer.stop();
  });

  test("check", async () => {
    const port = startedContainer.getMappedPort(4566);
    console.log(`port = ${port}`);
  });
});
