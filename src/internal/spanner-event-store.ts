import {
  type Database,
  Spanner,
  type Transaction,
} from "@google-cloud/spanner";
import type { EventStore } from "../event-store";
import type { SpannerEventStoreInput } from "../spanner-event-store-input";
import type { SpannerShardSelector } from "../spanner-shard-selector";
import {
  type Aggregate,
  type AggregateId,
  type Event,
  type EventSerializer,
  type Logger,
  OptimisticLockError,
  type SnapshotSerializer,
} from "../types";
import {
  JsonEventSerializer,
  JsonSnapshotSerializer,
} from "./default-serializer";
import { DefaultSpannerShardSelector } from "./default-spanner-shard-selector";
import {
  assertEventMatchesAggregate,
  assertExpectedVersion,
  assertPersistableUpdateEvent,
} from "./event-store-assertions";
import { convertJson } from "./json-converter";
import { SpannerAggregateKey } from "./spanner-aggregate-key";

type SpannerRow = Array<{
  name: string;
  value: unknown;
}>;

type SnapshotRow = {
  version: number;
  payload: Uint8Array;
};

const LATEST_SNAPSHOT_SEQUENCE_NUMBER = 0;
const SPANNER_ALREADY_EXISTS_CODE = 6;
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

class SpannerEventStoreConfigurationError extends Error {
  constructor(fieldName: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Invalid ${fieldName} configuration: ${message}`);
    this.name = "SpannerEventStoreConfigurationError";
    this.cause = cause;
  }
}

function createDefaultShardSelector<
  AID extends AggregateId,
>(): SpannerShardSelector<AID> {
  return new DefaultSpannerShardSelector<AID>();
}

class SpannerEventStore<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
> implements EventStore<AID, A, E>
{
  private readonly database: Database;
  private readonly journalTableName: string;
  private readonly snapshotTableName: string;
  private readonly quotedJournalTableName: string;
  private readonly quotedSnapshotTableName: string;
  private readonly shardCount: number;
  private readonly eventConverter: (json: unknown) => E;
  private readonly snapshotConverter: (json: unknown) => A;
  private readonly keepSnapshotCount: number | undefined;
  private readonly shardSelector: SpannerShardSelector<AID>;
  private readonly eventSerializer: EventSerializer<AID, E>;
  private readonly snapshotSerializer: SnapshotSerializer<AID, A>;
  private readonly logger: Logger | undefined;

  constructor(input: SpannerEventStoreInput<AID, A, E>) {
    this.assertConverter("eventConverter", input.eventConverter);
    this.assertConverter("snapshotConverter", input.snapshotConverter);
    this.assertShardCount(input.shardCount);
    this.database = input.database;
    this.journalTableName = this.assertTableName(
      "journalTableName",
      input.journalTableName,
    );
    this.snapshotTableName = this.assertTableName(
      "snapshotTableName",
      input.snapshotTableName,
    );
    this.quotedJournalTableName = this.quoteTableName(this.journalTableName);
    this.quotedSnapshotTableName = this.quoteTableName(this.snapshotTableName);
    this.shardCount = input.shardCount;
    this.eventConverter = input.eventConverter;
    this.snapshotConverter = input.snapshotConverter;
    this.keepSnapshotCount = input.keepSnapshotCount;
    this.shardSelector = input.shardSelector ?? createDefaultShardSelector();
    this.eventSerializer = input.eventSerializer ?? new JsonEventSerializer();
    this.snapshotSerializer =
      input.snapshotSerializer ?? new JsonSnapshotSerializer();
    this.logger = input.logger;
  }

  async getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
  ): Promise<E[]> {
    this.logger?.debug(
      `getEventsByIdSinceSequenceNumber(${JSON.stringify(
        id,
      )}, ${sequenceNumber}): start`,
    );
    const key = this.createKey(id);
    const [rows] = await this.database.run({
      sql: `
        SELECT payload
        FROM ${this.quotedJournalTableName}
        WHERE shard_id = @shardId
          AND aggregate_id = @aggregateId
          AND sequence_number >= @sequenceNumber
        ORDER BY sequence_number ASC
      `,
      params: {
        shardId: key.shardIdValue,
        aggregateId: key.aggregateIdValue,
        sequenceNumber,
      },
    });
    const events = (rows as SpannerRow[]).map((row) => {
      const payload = this.getBytes(row, "payload");
      return this.eventSerializer.deserialize(payload, (json) =>
        convertJson("eventConverter", this.eventConverter, json),
      );
    });
    this.logger?.debug(
      `getEventsByIdSinceSequenceNumber(${JSON.stringify(
        id,
      )}, ${sequenceNumber}): finished`,
    );
    return events;
  }

  async getLatestSnapshotById(id: AID): Promise<A | undefined> {
    this.logger?.debug(`getLatestSnapshotById(${JSON.stringify(id)}): start`);
    const key = this.createKey(id);
    const row = await this.readLatestSnapshot(this.database, key);
    if (row === undefined) {
      return undefined;
    }
    const snapshot = this.snapshotSerializer.deserialize(row.payload, (json) =>
      convertJson("snapshotConverter", this.snapshotConverter, json),
    );
    this.logger?.debug(
      `getLatestSnapshotById(${JSON.stringify(id)}): finished`,
    );
    return snapshot.withVersion(row.version);
  }

  async persistEvent(event: E, expectedVersion: number): Promise<void> {
    this.logger?.debug(
      `persistEvent(${JSON.stringify(event)}, ${expectedVersion}): start`,
    );
    assertPersistableUpdateEvent(event);
    await this.executeWrite(async () => {
      await this.updateEventAndSnapshotOpt(event, expectedVersion, undefined);
    });
    await this.purgeExcessSnapshots(event.aggregateId);
    this.logger?.debug(
      `persistEvent(${JSON.stringify(event)}, ${expectedVersion}): finished`,
    );
  }

  async persistEventAndSnapshot(event: E, aggregate: A): Promise<void> {
    assertEventMatchesAggregate(event, aggregate);
    this.logger?.debug(
      `persistEventAndSnapshot(${JSON.stringify(event)}, ${JSON.stringify(
        aggregate,
      )}): start`,
    );
    await this.executeWrite(async () => {
      if (event.isCreated) {
        await this.createEventAndSnapshot(event, aggregate);
        return;
      }
      await this.updateEventAndSnapshotOpt(event, aggregate.version, aggregate);
    });
    await this.purgeExcessSnapshots(event.aggregateId);
    this.logger?.debug(
      `persistEventAndSnapshot(${JSON.stringify(event)}, ${JSON.stringify(
        aggregate,
      )}): finished`,
    );
  }

  private async createEventAndSnapshot(event: E, aggregate: A): Promise<void> {
    const key = this.createKey(event.aggregateId);
    await this.runWriteTransaction(async (transaction) => {
      const latestSnapshot = await this.readLatestSnapshot(transaction, key);
      if (latestSnapshot !== undefined) {
        throw new OptimisticLockError("Aggregate already exists");
      }
      await this.insertJournal(transaction, key, event);
      await this.insertSnapshot(transaction, key, event, aggregate, {
        sequenceNumber: LATEST_SNAPSHOT_SEQUENCE_NUMBER,
        version: 1,
      });
      await this.insertRetainedSnapshot(transaction, key, event, aggregate, 1);
    });
  }

  private async updateEventAndSnapshotOpt(
    event: E,
    expectedVersion: number,
    aggregate: A | undefined,
  ): Promise<void> {
    const key = this.createKey(event.aggregateId);
    await this.runWriteTransaction(async (transaction) => {
      const latestSnapshot = await this.readLatestSnapshot(transaction, key);
      if (latestSnapshot === undefined) {
        throw new OptimisticLockError(
          `Aggregate does not exist: ${event.aggregateId.asString()}`,
        );
      }
      assertExpectedVersion(latestSnapshot.version, expectedVersion);
      const nextVersion = latestSnapshot.version + 1;
      await this.insertJournal(transaction, key, event);
      await this.updateLatestSnapshot(
        transaction,
        key,
        event,
        latestSnapshot.version,
        nextVersion,
        aggregate,
      );
      if (aggregate !== undefined) {
        await this.insertRetainedSnapshot(
          transaction,
          key,
          event,
          aggregate,
          nextVersion,
        );
      }
    });
  }

  private async readLatestSnapshot(
    queryable: Database | Transaction,
    key: SpannerAggregateKey<AID>,
  ): Promise<SnapshotRow | undefined> {
    const [rows] = await queryable.run({
      sql: `
        SELECT version, payload
        FROM ${this.quotedSnapshotTableName}
        WHERE shard_id = @shardId
          AND aggregate_id = @aggregateId
          AND sequence_number = @sequenceNumber
        LIMIT 1
      `,
      params: {
        shardId: key.shardIdValue,
        aggregateId: key.aggregateIdValue,
        sequenceNumber: LATEST_SNAPSHOT_SEQUENCE_NUMBER,
      },
    });
    const row = (rows as SpannerRow[])[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      version: this.getNumber(row, "version"),
      payload: this.getBytes(row, "payload"),
    };
  }

  private async insertJournal(
    transaction: Transaction,
    key: SpannerAggregateKey<AID>,
    event: E,
  ): Promise<void> {
    await transaction.runUpdate({
      sql: `
        INSERT INTO ${this.quotedJournalTableName}
          (shard_id, aggregate_id, sequence_number, payload, occurred_at)
        VALUES
          (@shardId, @aggregateId, @sequenceNumber, @payload, @occurredAt)
      `,
      params: {
        shardId: key.shardIdValue,
        aggregateId: key.aggregateIdValue,
        sequenceNumber: event.sequenceNumber,
        payload: Buffer.from(this.eventSerializer.serialize(event)),
        occurredAt: Spanner.timestamp(event.occurredAt.toISOString()),
      },
    });
  }

  private async insertSnapshot(
    transaction: Transaction,
    key: SpannerAggregateKey<AID>,
    event: E,
    aggregate: A,
    input: {
      sequenceNumber: number;
      version: number;
    },
  ): Promise<void> {
    await transaction.runUpdate({
      sql: `
        INSERT INTO ${this.quotedSnapshotTableName}
          (shard_id, aggregate_id, sequence_number, version, payload, updated_at)
        VALUES
          (@shardId, @aggregateId, @sequenceNumber, @version, @payload, @updatedAt)
      `,
      params: {
        shardId: key.shardIdValue,
        aggregateId: key.aggregateIdValue,
        sequenceNumber: input.sequenceNumber,
        version: input.version,
        payload: Buffer.from(this.snapshotSerializer.serialize(aggregate)),
        updatedAt: Spanner.timestamp(event.occurredAt.toISOString()),
      },
    });
  }

  private async insertRetainedSnapshot(
    transaction: Transaction,
    key: SpannerAggregateKey<AID>,
    event: E,
    aggregate: A,
    version: number,
  ): Promise<void> {
    if (this.keepSnapshotCount === undefined) {
      return;
    }
    await this.insertSnapshot(transaction, key, event, aggregate, {
      sequenceNumber: event.sequenceNumber,
      version,
    });
  }

  private async updateLatestSnapshot(
    transaction: Transaction,
    key: SpannerAggregateKey<AID>,
    event: E,
    beforeVersion: number,
    afterVersion: number,
    aggregate: A | undefined,
  ): Promise<void> {
    const payloadAssignment =
      aggregate === undefined ? "" : ", payload = @payload";
    const params: Record<string, unknown> = {
      shardId: key.shardIdValue,
      aggregateId: key.aggregateIdValue,
      sequenceNumber: LATEST_SNAPSHOT_SEQUENCE_NUMBER,
      beforeVersion,
      afterVersion,
      updatedAt: Spanner.timestamp(event.occurredAt.toISOString()),
    };
    if (aggregate !== undefined) {
      params.payload = Buffer.from(
        this.snapshotSerializer.serialize(aggregate),
      );
    }
    const [rowCount] = await transaction.runUpdate({
      sql: `
        UPDATE ${this.quotedSnapshotTableName}
        SET version = @afterVersion,
            updated_at = @updatedAt
            ${payloadAssignment}
        WHERE shard_id = @shardId
          AND aggregate_id = @aggregateId
          AND sequence_number = @sequenceNumber
          AND version = @beforeVersion
      `,
      params,
    });
    if (rowCount !== 1) {
      throw new OptimisticLockError("Optimistic locking failed");
    }
  }

  private async purgeExcessSnapshots(aggregateId: AID): Promise<void> {
    if (this.keepSnapshotCount === undefined) {
      return;
    }
    const keepCount = this.normalizeKeepSnapshotCount(this.keepSnapshotCount);
    const key = this.createKey(aggregateId);
    await this.runWriteTransaction(async (transaction) => {
      const [rows] = await transaction.run({
        sql: `
          SELECT sequence_number
          FROM ${this.quotedSnapshotTableName}
          WHERE shard_id = @shardId
            AND aggregate_id = @aggregateId
            AND sequence_number > @latestSequenceNumber
          ORDER BY sequence_number DESC
        `,
        params: {
          shardId: key.shardIdValue,
          aggregateId: key.aggregateIdValue,
          latestSequenceNumber: LATEST_SNAPSHOT_SEQUENCE_NUMBER,
        },
      });
      const excessSequenceNumbers = (rows as SpannerRow[])
        .map((row) => this.getNumber(row, "sequence_number"))
        .slice(keepCount);
      for (const sequenceNumber of excessSequenceNumbers) {
        await transaction.runUpdate({
          sql: `
            DELETE FROM ${this.quotedSnapshotTableName}
            WHERE shard_id = @shardId
              AND aggregate_id = @aggregateId
              AND sequence_number = @sequenceNumber
          `,
          params: {
            shardId: key.shardIdValue,
            aggregateId: key.aggregateIdValue,
            sequenceNumber,
          },
        });
      }
    });
  }

  private async runWriteTransaction(
    operation: (transaction: Transaction) => Promise<void>,
  ): Promise<void> {
    await this.database.runTransactionAsync(
      async (transaction: Transaction) => {
        try {
          await operation(transaction);
        } catch (error) {
          await transaction.rollback();
          throw error;
        }
        await transaction.commit();
      },
    );
  }

  private async executeWrite(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (this.isAlreadyExistsError(error)) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new OptimisticLockError("Optimistic locking failed", cause);
      }
      // ABORTED is retried by Database.runTransactionAsync. Other infrastructure
      // errors are not deterministic optimistic lock conflicts, so callers see
      // the original Spanner failure.
      throw error;
    }
  }

  private isAlreadyExistsError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === SPANNER_ALREADY_EXISTS_CODE
    );
  }

  private createKey(aggregateId: AID): SpannerAggregateKey<AID> {
    return SpannerAggregateKey.create(
      aggregateId,
      this.shardSelector,
      this.shardCount,
    );
  }

  private getNumber(row: SpannerRow, fieldName: string): number {
    const value = this.getField(row, fieldName);
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      return Number(value);
    }
    if (typeof value === "object" && value !== null && "value" in value) {
      return Number((value as { value: unknown }).value);
    }
    throw new Error(`${fieldName} is not a number`);
  }

  private getBytes(row: SpannerRow, fieldName: string): Uint8Array {
    const value = this.getField(row, fieldName);
    if (value instanceof Uint8Array) {
      return value;
    }
    if (typeof value === "string") {
      return Buffer.from(value, "base64");
    }
    throw new Error(`${fieldName} is not bytes`);
  }

  private getField(row: SpannerRow, fieldName: string): unknown {
    const field = row.find((candidate) => candidate.name === fieldName);
    if (field === undefined) {
      throw new Error(`${fieldName} is undefined`);
    }
    return field.value;
  }

  private normalizeKeepSnapshotCount(keepSnapshotCount: number): number {
    if (!Number.isFinite(keepSnapshotCount)) {
      throw new Error(
        `keepSnapshotCount must be finite, got ${keepSnapshotCount}`,
      );
    }
    return Math.max(0, Math.floor(keepSnapshotCount));
  }

  private assertConverter(name: string, converter: unknown): void {
    if (typeof converter !== "function") {
      throw new SpannerEventStoreConfigurationError(
        name,
        new Error("must be a function"),
      );
    }
  }

  private assertShardCount(shardCount: number): void {
    if (!Number.isSafeInteger(shardCount) || shardCount <= 0) {
      throw new SpannerEventStoreConfigurationError(
        "shardCount",
        new Error(`must be a positive safe integer, got ${String(shardCount)}`),
      );
    }
  }

  private assertTableName(fieldName: string, tableName: string): string {
    if (!TABLE_NAME_PATTERN.test(tableName)) {
      throw new SpannerEventStoreConfigurationError(
        fieldName,
        new Error(`must be a GoogleSQL identifier, got ${tableName}`),
      );
    }
    return tableName;
  }

  private quoteTableName(tableName: string): string {
    return `\`${tableName}\``;
  }
}

export { SpannerEventStore };
