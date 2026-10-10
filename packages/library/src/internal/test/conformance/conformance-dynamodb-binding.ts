import assert from "node:assert/strict";
import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import type { DynamoDBEventStoreInput } from "../../../dynamodb-event-store-input";
import { EventStore } from "../../../event-store";
import * as dynamoDBFactory from "../../dynamodb-event-store";
import type { DynamoDBLocal } from "../dynamodb-local";
import { DynamoDBPersistEventObservation } from "../dynamodb-persist-event-observation";
import { executeConformanceOperation } from "./conformance-case-executor";
import type { ConformanceCreatedStore } from "./conformance-created-store";
import { ConformanceDynamoDBFaults } from "./conformance-dynamodb-faults";
import { encodeDeclaredItem } from "./conformance-dynamodb-items";
import { ConformanceDynamoDBObservation } from "./conformance-dynamodb-observation";
import { ConformanceFaultRegistry } from "./conformance-fault-registry";
import { recordOf, textOf } from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";
import { ConformancePublicBinding } from "./conformance-public-binding";
import type { ConformanceStoreCreation } from "./conformance-store-creation";

export class ConformanceDynamoDBBinding extends ConformancePublicBinding {
  readonly backend = "dynamodb";
  constructor(private readonly local: DynamoDBLocal) {
    super();
  }

  async createStore(
    creation: ConformanceStoreCreation,
  ): Promise<ConformanceCreatedStore<unknown, unknown>> {
    const layout = await this.local.createTables(
      creation.config.retentionMode === "ttl",
    );
    const client = this.local.createClient();
    const observer = this.local.createClient();
    let notifications: string[] = [];
    let operation = 0;
    let clock = creation.clockEpochSeconds;
    let faults!: ConformanceDynamoDBFaults;
    let interleaved: unknown[] = [];
    const registry = new ConformanceFaultRegistry(creation.faults);
    const observation = new DynamoDBPersistEventObservation(client, undefined, {
      context: (command, input) => faults.context(command, input),
      before: (command, input) => faults.before(command, input),
      after: (command, input, output) => faults.after(command, input, output),
    });
    const inspection = new ConformanceDynamoDBObservation(
      observer,
      layout.tables,
      layout.snapshotAidIndexName,
      observation,
      () => operation,
    );
    const input: DynamoDBEventStoreInput<
      ConformanceJsonValue,
      ConformanceJsonValue
    > = {
      ...layout,
      client,
      retryLimit: creation.config.retryLimit,
      retention:
        creation.config.retentionCount === null
          ? undefined
          : {
              count: creation.config.retentionCount,
              mode:
                creation.config.retentionMode === "ttl"
                  ? {
                      type: "ttl",
                      graceSeconds: creation.config.ttlGraceSeconds as number,
                    }
                  : { type: "delete" },
            },
      eventSerializer: this.serializer(registry, "event"),
      snapshotSerializer: this.serializer(registry, "snapshot"),
      onRetentionFailure: (failure) => {
        notifications = [...notifications, failure.kind];
      },
      logger: { ...console, error: () => undefined },
    };
    faults = new ConformanceDynamoDBFaults(
      registry,
      observer,
      layout.tables,
      layout.snapshotAidIndexName,
      observation,
      async (step) => {
        const otherClient = this.local.createClient();
        const otherObservation = new DynamoDBPersistEventObservation(
          otherClient,
        );
        try {
          const opened = await EventStore.createDynamoDB({
            ...input,
            client: otherClient,
          });
          if (opened.type !== "ok") throw opened.error;
          const result = await executeConformanceOperation(
            this,
            this.wrapStore(opened.value),
            step,
            creation.fixtures ?? {},
          );
          assert.equal(
            result.kind,
            "ok",
            "interleaved public operation must commit",
          );
          interleaved = [
            ...interleaved,
            { operation, step, result, requests: otherObservation.snapshot() },
          ];
        } finally {
          otherClient.destroy();
        }
      },
    );
    faults.begin(0);
    const dispose = async () => {
      try {
        await this.local.deleteTables(layout.tables);
      } finally {
        client.destroy();
        observer.destroy();
      }
    };
    try {
      for (const item of creation.seedItems) {
        const table = textOf(
          recordOf(item).table,
        ) as keyof typeof layout.tables;
        await observer.send(
          new PutItemCommand({
            TableName: layout.tables[table],
            Item: encodeDeclaredItem(item),
          }),
        );
      }
      const original = dynamoDBFactory.initializeDynamoDBEventStoreInternal;
      const wrapper = jest
        .spyOn(dynamoDBFactory, "initializeDynamoDBEventStoreInternal")
        .mockImplementation(<PE, PS>(input: DynamoDBEventStoreInput<PE, PS>) =>
          original(input, {
            clock: () => {
              assert.ok(clock !== undefined, "TTL case must supply clock");
              return clock;
            },
            sleep: async (milliseconds) => {
              inspection.sleep(milliseconds);
            },
          }),
        );
      let opened: Awaited<
        ReturnType<
          typeof EventStore.createDynamoDB<
            ConformanceJsonValue,
            ConformanceJsonValue
          >
        >
      >;
      try {
        opened = await EventStore.createDynamoDB(input);
      } finally {
        wrapper.mockRestore();
      }
      return {
        outcome:
          opened.type === "err"
            ? this.outcome<never>(opened)
            : { kind: "ok" as const, value: this.wrapStore(opened.value) },
        hooks: {
          beginOperation: (next: number) => {
            operation = next;
            faults.begin(next);
          },
          finishOperation: (number: number) => faults.finish(number),
          setClockEpochSeconds: (seconds: number) => {
            clock = seconds;
          },
          readHistory: (id: { typeName: string; value: string }) =>
            inspection.readHistory(id),
          takeRetentionFailures: () => {
            const taken = notifications;
            notifications = [];
            return taken;
          },
          checkStorageObservation: (
            observe: ConformanceJsonValue,
            args: ConformanceJsonValue,
          ) => inspection.check(observe, args),
          checkLayout: (body: ConformanceJsonValue) =>
            inspection.checkLayout(body),
          evidence: () => ({
            faults: faults.evidence(),
            storage: inspection.evidence(),
            interleaved,
          }),
        },
        dispose,
      };
    } catch (cause) {
      await dispose();
      throw cause;
    }
  }
}
