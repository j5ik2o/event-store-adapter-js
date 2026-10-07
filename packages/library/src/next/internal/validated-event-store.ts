import { Result } from "../../result";
import { AggregateId } from "../aggregate-id";
import { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import { SnapshotEnvelope } from "../snapshot-envelope";
import { validateSeqNr } from "./seq-nr-validation";

function validateAggregateId(
  aggregateId: AggregateId,
): Result<string, EventStoreError> {
  if (aggregateId === undefined || aggregateId === null) {
    return Result.err(
      EventStoreError.contractViolation({
        rule: "T-2",
        detail: "aggregateId is missing",
      }),
    );
  }
  return AggregateId.asString(aggregateId);
}

function validateEvent<P>(
  event: EventEnvelope<P>,
): Result<EventEnvelope<P>, EventStoreError> {
  const envelope = EventEnvelope.create(event);
  if (envelope.type === "err") {
    return envelope;
  }
  const aggregateId = validateAggregateId(envelope.value.aggregateId);
  return aggregateId.type === "err" ? aggregateId : envelope;
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
      const validatedEvent = validateEvent(event);
      if (validatedEvent.type === "err") {
        return validatedEvent;
      }
      const validatedSnapshot = SnapshotEnvelope.create(snapshot);
      if (validatedSnapshot.type === "err") {
        return validatedSnapshot;
      }
      if (validatedEvent.value.seqNr !== validatedSnapshot.value.seqNr) {
        return Result.err(
          EventStoreError.contractViolation({
            rule: "W-9",
            seqNr: validatedEvent.value.seqNr,
            snapshotSeqNr: validatedSnapshot.value.seqNr,
          }),
        );
      }
      return target.persistEventAndSnapshot(
        validatedEvent.value,
        validatedSnapshot.value,
      );
    },

    async getLatestSnapshotById(aggregateId) {
      const validated = validateAggregateId(aggregateId);
      if (validated.type === "err") {
        return validated;
      }
      return target.getLatestSnapshotById(aggregateId);
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
      return target.getEventsByIdSinceSeqNr(aggregateId, validatedSeqNr.value);
    },
  });
}
