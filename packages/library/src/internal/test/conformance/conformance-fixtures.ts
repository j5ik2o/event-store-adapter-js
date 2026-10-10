import type { ConformanceEventData } from "./conformance-event-data";
import {
  aggregateIdOf,
  integerOf,
  recordOf,
  textOf,
} from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";
import { nativeTimeEpochNanos } from "./conformance-time";

export function eventInputOf(value: ConformanceJsonValue | undefined) {
  const event = recordOf(value);
  return {
    aggregateId: aggregateIdOf(event.aggregate_id),
    seqNr: integerOf(event.seq_nr),
    occurredAtEpochNanos: integerOf(event.occurred_at),
    payload: event.payload,
    ...(event.manifest === undefined
      ? {}
      : { manifest: textOf(event.manifest) }),
  };
}

export function snapshotInputOf(value: ConformanceJsonValue | undefined) {
  const snapshot = recordOf(value);
  return {
    seqNr: integerOf(snapshot.seq_nr),
    aggregate: snapshot.aggregate,
    ...(snapshot.manifest === undefined
      ? {}
      : { manifest: textOf(snapshot.manifest) }),
  };
}

export function expectedEventOf(
  value: ConformanceJsonValue | undefined,
): ConformanceEventData {
  const input = eventInputOf(value);
  return {
    ...input,
    occurredAtEpochNanos: nativeTimeEpochNanos(input.occurredAtEpochNanos),
    manifest: input.manifest ?? "",
  };
}
