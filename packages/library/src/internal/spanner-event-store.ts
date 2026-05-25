import {
  type Database,
  Spanner,
  type Transaction,
} from "@google-cloud/spanner";
import type { EventStore } from "../event-store";
import type { SpannerEventStoreInput } from "../spanner-event-store-input";
import {
  type Aggregate,
  type AggregateId,
  type Event,
  EventStoreError,
  Result,
  ShardCount,
} from "../types";
import {
  createJsonEventSerializer,
  createJsonSnapshotSerializer,
} from "./default-serializer";
import { createDefaultShardSelector } from "./default-shard-selector";
import {
  assertEventMatchesAggregate,
  assertPersistableUpdateEvent,
  toExpectedVersionError,
} from "./event-store-assertions";
import { convertJson } from "./json-converter";
import {
  createSpannerAggregateKey,
  type SpannerAggregateKey,
} from "./spanner-aggregate-key";

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

function createSpannerEventStore<
  AID extends AggregateId,
  A extends Aggregate<A, AID>,
  E extends Event<AID>,
>(input: SpannerEventStoreInput<AID, A, E>): EventStore<AID, A, E> {
  assertConverter("eventConverter", input.eventConverter);
  assertConverter("snapshotConverter", input.snapshotConverter);
  const shardCount = parseShardCount(input.shardCount);
  const database = input.database;
  const journalTableName = assertTableName(
    "journalTableName",
    input.journalTableName,
  );
  const snapshotTableName = assertTableName(
    "snapshotTableName",
    input.snapshotTableName,
  );
  const quotedJournalTableName = quoteTableName(journalTableName);
  const quotedSnapshotTableName = quoteTableName(snapshotTableName);
  const eventConverter = input.eventConverter;
  const snapshotConverter = input.snapshotConverter;
  const keepSnapshotCount =
    input.keepSnapshotCount === undefined
      ? undefined
      : normalizeKeepSnapshotCount(input.keepSnapshotCount);
  const shardSelector =
    input.shardSelector ?? createDefaultShardSelector<AID>();
  const eventSerializer = input.eventSerializer ?? createJsonEventSerializer();
  const snapshotSerializer =
    input.snapshotSerializer ?? createJsonSnapshotSerializer();
  const logger = input.logger;

  async function getEventsByIdSinceSequenceNumber(
    id: AID,
    sequenceNumber: number,
  ): Promise<E[]> {
    logger?.debug(
      `getEventsByIdSinceSequenceNumber(${JSON.stringify(
        id,
      )}, ${sequenceNumber}): start`,
    );
    const key = createKey(id);
    const [rows] = await database.run({
      sql: `
        SELECT payload
        FROM ${quotedJournalTableName}
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
      const payload = getBytes(row, "payload");
      return eventSerializer.deserialize(payload, (json) =>
        convertJson("eventConverter", eventConverter, json),
      );
    });
    logger?.debug(
      `getEventsByIdSinceSequenceNumber(${JSON.stringify(
        id,
      )}, ${sequenceNumber}): finished`,
    );
    return events;
  }

  async function getLatestSnapshotById(id: AID): Promise<A | undefined> {
    logger?.debug(`getLatestSnapshotById(${JSON.stringify(id)}): start`);
    const key = createKey(id);
    const row = await readLatestSnapshot(database, key);
    if (row === undefined) {
      return undefined;
    }
    const snapshot = snapshotSerializer.deserialize(row.payload, (json) =>
      convertJson("snapshotConverter", snapshotConverter, json),
    );
    logger?.debug(`getLatestSnapshotById(${JSON.stringify(id)}): finished`);
    return snapshot.withVersion(row.version);
  }

  async function persistEvent(event: E, expectedVersion: number) {
    logger?.debug(
      `persistEvent(aggregateId=${event.aggregateId.asString()}, sequenceNumber=${event.sequenceNumber}, expectedVersion=${expectedVersion}): start`,
    );
    assertPersistableUpdateEvent(event);
    const writeError = await executeWrite(async () => {
      await updateEventAndSnapshotOpt(event, expectedVersion, undefined);
    });
    if (writeError !== undefined) {
      return Result.err(writeError);
    }
    const purgeError = await purgeExcessSnapshots(event.aggregateId);
    if (purgeError !== undefined) {
      return Result.err(purgeError);
    }
    logger?.debug(
      `persistEvent(aggregateId=${event.aggregateId.asString()}, sequenceNumber=${event.sequenceNumber}, expectedVersion=${expectedVersion}): finished`,
    );
    return Result.ok(undefined);
  }

  async function persistEventAndSnapshot(event: E, aggregate: A) {
    assertEventMatchesAggregate(event, aggregate);
    logger?.debug(
      `persistEventAndSnapshot(aggregateId=${event.aggregateId.asString()}, sequenceNumber=${event.sequenceNumber}, aggregateVersion=${aggregate.version}): start`,
    );
    const writeError = await executeWrite(async () => {
      if (event.isCreated) {
        await createEventAndSnapshot(event, aggregate);
        return;
      }
      await updateEventAndSnapshotOpt(event, aggregate.version, aggregate);
    });
    if (writeError !== undefined) {
      return Result.err(writeError);
    }
    const purgeError = await purgeExcessSnapshots(event.aggregateId);
    if (purgeError !== undefined) {
      return Result.err(purgeError);
    }
    logger?.debug(
      `persistEventAndSnapshot(aggregateId=${event.aggregateId.asString()}, sequenceNumber=${event.sequenceNumber}, aggregateVersion=${aggregate.version}): finished`,
    );
    return Result.ok(undefined);
  }

  async function createEventAndSnapshot(event: E, aggregate: A): Promise<void> {
    const key = createKey(event.aggregateId);
    await runWriteTransaction(async (transaction) => {
      const latestSnapshot = await readLatestSnapshot(transaction, key);
      if (latestSnapshot !== undefined) {
        throw EventStoreError.optimisticLockConflict(
          "Aggregate already exists",
        );
      }
      await insertJournal(transaction, key, event);
      await insertSnapshot(transaction, key, event, aggregate, {
        sequenceNumber: LATEST_SNAPSHOT_SEQUENCE_NUMBER,
        version: 1,
      });
      await insertRetainedSnapshot(transaction, key, event, aggregate, 1);
    });
  }

  async function updateEventAndSnapshotOpt(
    event: E,
    expectedVersion: number,
    aggregate: A | undefined,
  ): Promise<void> {
    const key = createKey(event.aggregateId);
    await runWriteTransaction(async (transaction) => {
      const latestSnapshot = await readLatestSnapshot(transaction, key);
      if (latestSnapshot === undefined) {
        throw EventStoreError.optimisticLockConflict(
          `Aggregate does not exist: ${event.aggregateId.asString()}`,
        );
      }
      const versionError = toExpectedVersionError(
        latestSnapshot.version,
        expectedVersion,
      );
      if (versionError !== undefined) {
        throw versionError;
      }
      const nextVersion = latestSnapshot.version + 1;
      await insertJournal(transaction, key, event);
      await updateLatestSnapshot(
        transaction,
        key,
        event,
        latestSnapshot.version,
        nextVersion,
        aggregate,
      );
      if (aggregate !== undefined) {
        await insertRetainedSnapshot(
          transaction,
          key,
          event,
          aggregate,
          nextVersion,
        );
      }
    });
  }

  async function readLatestSnapshot(
    queryable: Database | Transaction,
    key: SpannerAggregateKey<AID>,
  ): Promise<SnapshotRow | undefined> {
    const [rows] = await queryable.run({
      sql: `
        SELECT version, payload
        FROM ${quotedSnapshotTableName}
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
      version: getNumber(row, "version"),
      payload: getBytes(row, "payload"),
    };
  }

  async function insertJournal(
    transaction: Transaction,
    key: SpannerAggregateKey<AID>,
    event: E,
  ): Promise<void> {
    try {
      await transaction.runUpdate({
        sql: `
        INSERT INTO ${quotedJournalTableName}
          (shard_id, aggregate_id, sequence_number, payload, occurred_at)
        VALUES
          (@shardId, @aggregateId, @sequenceNumber, @payload, @occurredAt)
      `,
        params: {
          shardId: key.shardIdValue,
          aggregateId: key.aggregateIdValue,
          sequenceNumber: event.sequenceNumber,
          payload: Buffer.from(serializeEvent(event)),
          occurredAt: Spanner.timestamp(event.occurredAt.toISOString()),
        },
      });
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw EventStoreError.optimisticLockConflict(
          "Optimistic locking failed",
          error,
        );
      }
      throw error;
    }
  }

  async function insertSnapshot(
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
        INSERT INTO ${quotedSnapshotTableName}
          (shard_id, aggregate_id, sequence_number, version, payload, updated_at)
        VALUES
          (@shardId, @aggregateId, @sequenceNumber, @version, @payload, @updatedAt)
      `,
      params: {
        shardId: key.shardIdValue,
        aggregateId: key.aggregateIdValue,
        sequenceNumber: input.sequenceNumber,
        version: input.version,
        payload: Buffer.from(serializeSnapshot(aggregate)),
        updatedAt: Spanner.timestamp(event.occurredAt.toISOString()),
      },
    });
  }

  async function insertRetainedSnapshot(
    transaction: Transaction,
    key: SpannerAggregateKey<AID>,
    event: E,
    aggregate: A,
    version: number,
  ): Promise<void> {
    if (keepSnapshotCount === undefined || keepSnapshotCount === 0) {
      return;
    }
    await insertSnapshot(transaction, key, event, aggregate, {
      sequenceNumber: event.sequenceNumber,
      version,
    });
  }

  async function updateLatestSnapshot(
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
      params.payload = Buffer.from(serializeSnapshot(aggregate));
    }
    const [rowCount] = await transaction.runUpdate({
      sql: `
        UPDATE ${quotedSnapshotTableName}
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
      throw EventStoreError.optimisticLockConflict("Optimistic locking failed");
    }
  }

  async function purgeExcessSnapshots(
    aggregateId: AID,
  ): Promise<EventStoreError | undefined> {
    if (keepSnapshotCount === undefined || keepSnapshotCount === 0) {
      return undefined;
    }
    try {
      const keepCount = keepSnapshotCount;
      const key = createKey(aggregateId);
      await runWriteTransaction(async (transaction) => {
        const [rows] = await transaction.run({
          sql: `
          SELECT sequence_number
          FROM ${quotedSnapshotTableName}
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
          .map((row) => getNumber(row, "sequence_number"))
          .slice(keepCount);
        for (const sequenceNumber of excessSequenceNumbers) {
          await transaction.runUpdate({
            sql: `
            DELETE FROM ${quotedSnapshotTableName}
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
      return undefined;
    } catch (error) {
      if (isEventStoreError(error)) {
        return error;
      }
      return EventStoreError.storage(
        "Spanner snapshot retention failed",
        error,
      );
    }
  }

  async function runWriteTransaction(
    operation: (transaction: Transaction) => Promise<void>,
  ): Promise<void> {
    await database.runTransactionAsync(async (transaction: Transaction) => {
      await operation(transaction);
      await transaction.commit();
    });
  }

  async function executeWrite(
    operation: () => Promise<void>,
  ): Promise<EventStoreError | undefined> {
    try {
      await operation();
      return undefined;
    } catch (error) {
      if (isEventStoreError(error)) {
        return error;
      }
      if (isAlreadyExistsError(error)) {
        return EventStoreError.optimisticLockConflict(
          "Optimistic locking failed",
          error,
        );
      }
      return EventStoreError.storage("Spanner write failed", error);
    }
  }

  function isAlreadyExistsError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "number" &&
      (error as { code: number }).code === SPANNER_ALREADY_EXISTS_CODE
    );
  }

  function isEventStoreError(error: unknown): error is EventStoreError {
    return (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      typeof (error as { type: unknown }).type === "string" &&
      [
        "optimistic-lock-conflict",
        "configuration-error",
        "serialization-error",
        "storage-error",
      ].includes((error as { type: string }).type)
    );
  }

  function serializeEvent(event: E): Uint8Array {
    try {
      return eventSerializer.serialize(event);
    } catch (error) {
      throw EventStoreError.serialization(
        "serialize",
        "Spanner event serialization failed",
        error,
      );
    }
  }

  function serializeSnapshot(aggregate: A): Uint8Array {
    try {
      return snapshotSerializer.serialize(aggregate);
    } catch (error) {
      throw EventStoreError.serialization(
        "serialize",
        "Spanner snapshot serialization failed",
        error,
      );
    }
  }

  function createKey(aggregateId: AID): SpannerAggregateKey<AID> {
    return createSpannerAggregateKey(aggregateId, shardSelector, shardCount);
  }

  function getNumber(row: SpannerRow, fieldName: string): number {
    const value = getField(row, fieldName);
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new Error(`${fieldName} is not a safe integer`);
      }
      return value;
    }
    if (typeof value === "string") {
      return parseSafeInteger(fieldName, value);
    }
    if (typeof value === "object" && value !== null && "value" in value) {
      const wrappedValue = (value as Record<string, unknown>).value;
      if (typeof wrappedValue === "number") {
        if (!Number.isSafeInteger(wrappedValue)) {
          throw new Error(`${fieldName} is not a safe integer`);
        }
        return wrappedValue;
      }
      if (typeof wrappedValue === "string") {
        return parseSafeInteger(fieldName, wrappedValue);
      }
      throw new Error(`${fieldName} is not a number`);
    }
    throw new Error(`${fieldName} is not a number`);
  }

  function parseSafeInteger(fieldName: string, value: unknown): number {
    const numberValue = Number(value);
    if (!Number.isSafeInteger(numberValue)) {
      throw new Error(`${fieldName} is not a safe integer`);
    }
    return numberValue;
  }

  function getBytes(row: SpannerRow, fieldName: string): Uint8Array {
    const value = getField(row, fieldName);
    if (value instanceof Uint8Array) {
      return value;
    }
    if (typeof value === "string") {
      if (!isBase64(value)) {
        throw new Error(`${fieldName} is not valid base64`);
      }
      return Buffer.from(value, "base64");
    }
    throw new Error(`${fieldName} is not bytes`);
  }

  function isBase64(value: string): boolean {
    return (
      value.length > 0 &&
      value.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(value)
    );
  }

  function getField(row: SpannerRow, fieldName: string): unknown {
    const field = row.find((candidate) => candidate.name === fieldName);
    if (field === undefined) {
      throw new Error(`${fieldName} is undefined`);
    }
    return field.value;
  }

  function normalizeKeepSnapshotCount(keepSnapshotCountInput: number): number {
    if (!Number.isFinite(keepSnapshotCountInput)) {
      throw new Error(
        `keepSnapshotCount must be finite, got ${keepSnapshotCountInput}`,
      );
    }
    return Math.max(0, Math.floor(keepSnapshotCountInput));
  }

  function assertConverter(name: string, converter: unknown): void {
    if (typeof converter !== "function") {
      throw createConfigurationError(name, new Error("must be a function"));
    }
  }

  function parseShardCount(shardCountInput: number): ShardCount {
    try {
      return ShardCount.create(shardCountInput);
    } catch (cause) {
      throw createConfigurationError("shardCount", cause);
    }
  }

  function assertTableName(fieldName: string, tableName: string): string {
    if (!TABLE_NAME_PATTERN.test(tableName)) {
      throw createConfigurationError(
        fieldName,
        new Error(`must be a GoogleSQL identifier, got ${tableName}`),
      );
    }
    return tableName;
  }

  function quoteTableName(tableName: string): string {
    return `\`${tableName}\``;
  }

  return Object.freeze({
    persistEvent,
    persistEventAndSnapshot,
    getEventsByIdSinceSequenceNumber,
    getLatestSnapshotById,
  });
}

function createConfigurationError(fieldName: string, cause: unknown): Error {
  /* istanbul ignore next -- internal callers pass Error causes. */
  const message = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(`Invalid ${fieldName} configuration: ${message}`);
  error.name = "SpannerEventStoreConfigurationError";
  error.cause = cause;
  return error;
}

export { createSpannerEventStore };
