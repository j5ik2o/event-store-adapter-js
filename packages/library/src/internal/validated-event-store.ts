import { AggregateId } from "../aggregate-id";
import { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { SnapshotEnvelope } from "../snapshot-envelope";
import { validateSeqNr } from "./seq-nr-validation";

export function validateAggregateId(
  aggregateId: AggregateId,
): Result<AggregateId, EventStoreError> {
  if (aggregateId === undefined || aggregateId === null) {
    return Result.err(
      EventStoreError.contractViolation({
        rule: "T-2",
        detail: "aggregateId is missing",
      }),
    );
  }
  let typeName: string;
  let value: string;
  try {
    typeName = aggregateId.typeName;
    value = aggregateId.value;
  } catch (cause) {
    return Result.err(
      EventStoreError.contractViolation({
        rule: "T-2",
        detail: "aggregateId element access failed",
        cause,
      }),
    );
  }
  return AggregateId.of(typeName, value);
}

export function validateEvent<P>(
  event: EventEnvelope<P>,
): Result<EventEnvelope<P>, EventStoreError> {
  const envelope = EventEnvelope.create(event);
  if (envelope.type === "err") {
    return envelope;
  }
  const aggregateId = validateAggregateId(envelope.value.aggregateId);
  if (aggregateId.type === "err") {
    return aggregateId;
  }
  return Result.ok(
    Object.freeze({ ...envelope.value, aggregateId: aggregateId.value }),
  );
}

export function validateEventAndSnapshot<PE, PS>(
  event: EventEnvelope<PE>,
  snapshot: SnapshotEnvelope<PS>,
): Result<
  Readonly<{ event: EventEnvelope<PE>; snapshot: SnapshotEnvelope<PS> }>,
  EventStoreError
> {
  const validatedEvent = validateEvent(event);
  if (validatedEvent.type === "err") return validatedEvent;
  const validatedSnapshot = SnapshotEnvelope.create(snapshot);
  if (validatedSnapshot.type === "err") return validatedSnapshot;
  if (validatedEvent.value.seqNr !== validatedSnapshot.value.seqNr) {
    return Result.err(
      EventStoreError.contractViolation({
        rule: "W-9",
        seqNr: validatedEvent.value.seqNr,
        snapshotSeqNr: validatedSnapshot.value.seqNr,
      }),
    );
  }
  return Result.ok(
    Object.freeze({
      event: validatedEvent.value,
      snapshot: validatedSnapshot.value,
    }),
  );
}

export function createValidatedEventStore<PE, PS>(
  target: EventStore<PE, PS>,
): EventStore<PE, PS> {
  return Object.freeze<EventStore<PE, PS>>({
    async persistEvent(event) {
      const validated = validateEvent(event);
      if (validated.type === "err") {
        return validated;
      }
      return target.persistEvent(validated.value);
    },

    async persistEventAndSnapshot(event, snapshot) {
      const validated = validateEventAndSnapshot(event, snapshot);
      if (validated.type === "err") return validated;
      return target.persistEventAndSnapshot(
        validated.value.event,
        validated.value.snapshot,
      );
    },

    async getLatestSnapshotById(aggregateId) {
      const validated = validateAggregateId(aggregateId);
      if (validated.type === "err") {
        return validated;
      }
      return target.getLatestSnapshotById(validated.value);
    },

    async getEventsByIdSinceSeqNr(aggregateId, seqNr) {
      const validatedId = validateAggregateId(aggregateId);
      if (validatedId.type === "err") {
        return validatedId;
      }
      const validatedSeqNr = validateSeqNr(seqNr);
      if (validatedSeqNr.type === "err") {
        return validatedSeqNr;
      }
      return target.getEventsByIdSinceSeqNr(
        validatedId.value,
        validatedSeqNr.value,
      );
    },
  });
}
