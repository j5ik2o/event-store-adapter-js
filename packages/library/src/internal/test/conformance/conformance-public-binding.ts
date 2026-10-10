import { AggregateId } from "../../../aggregate-id";
import { EventEnvelope } from "../../../event-envelope";
import type { EventStore } from "../../../event-store";
import type { EventStoreError } from "../../../event-store-error";
import { PayloadSerializer } from "../../../payload-serializer";
import { Result } from "../../../result";
import { SnapshotEnvelope } from "../../../snapshot-envelope";
import { validateSeqNr } from "../../seq-nr-validation";
import type { ConformanceAggregateIdInput } from "./conformance-aggregate-id-input";
import type { ConformanceBackend } from "./conformance-backend";
import type { ConformanceCreatedStore } from "./conformance-created-store";
import type { ConformanceEventInput } from "./conformance-event-input";
import type { ConformanceFaultRegistry } from "./conformance-fault-registry";
import { recordOf } from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";
import type { ConformanceOutcome } from "./conformance-outcome";
import type { ConformanceSnapshotInput } from "./conformance-snapshot-input";
import type { ConformanceStore } from "./conformance-store";
import type { ConformanceStoreBinding } from "./conformance-store-binding";
import type { ConformanceStoreCreation } from "./conformance-store-creation";
import { nativeTimeEpochNanos } from "./conformance-time";

export abstract class ConformancePublicBinding
  implements ConformanceStoreBinding<unknown, unknown>
{
  abstract readonly backend: ConformanceBackend;
  abstract createStore(
    creation: ConformanceStoreCreation,
  ): Promise<ConformanceCreatedStore<unknown, unknown>>;

  outcome<T>(result: Result<T, EventStoreError>): ConformanceOutcome<T> {
    if (result.type === "ok") return { kind: "ok", value: result.value };
    const error = result.error;
    const categories = {
      "optimistic-lock-conflict": "optimistic-lock",
      "contract-violation": "contract-violation",
      "serialization-error": "serialization",
      "configuration-error": "configuration",
      "storage-error": "storage",
    } as const;
    return {
      kind: "error",
      category: categories[error.type],
      message: error.message,
      ...(error.type === "contract-violation" ? { rule: error.rule } : {}),
      cause: error.cause,
    };
  }

  buildAggregateId(
    input: ConformanceAggregateIdInput,
  ): ConformanceOutcome<string> {
    const id = AggregateId.of(input.typeName, input.value);
    if (id.type === "err") return this.outcome(id);
    return this.outcome(
      AggregateId.asString({
        ...id.value,
        ...(input.userString === undefined
          ? {}
          : {
              asString: () => input.userString,
              toString: () => input.userString,
            }),
      }),
    );
  }

  buildEvent(input: ConformanceEventInput) {
    return this.outcome(
      EventEnvelope.create({
        ...input,
        seqNr: Number(input.seqNr),
        occurredAt: new Date(
          Number(
            nativeTimeEpochNanos(input.occurredAtEpochNanos) / BigInt(1000000),
          ),
        ),
      }),
    );
  }

  buildSnapshot(input: ConformanceSnapshotInput) {
    return this.outcome(
      SnapshotEnvelope.create({ ...input, seqNr: Number(input.seqNr) }),
    );
  }

  validateSeqNrValue(seqNr: bigint, context: "event" | "value" = "value") {
    if (context === "event") {
      const built = EventEnvelope.create({
        aggregateId: { typeName: "ConformanceSeq", value: "value" },
        seqNr: Number(seqNr),
        occurredAt: new Date(0),
        payload: null,
      });
      return this.outcome(
        built.type === "err" ? built : Result.ok(BigInt(built.value.seqNr)),
      );
    }
    const result = validateSeqNr(Number(seqNr));
    return this.outcome(
      result.type === "err" ? result : Result.ok(BigInt(result.value)),
    );
  }

  wrapStore(
    store: EventStore<ConformanceJsonValue, ConformanceJsonValue>,
  ): ConformanceStore<unknown, unknown> {
    return {
      persistEvent: async (event) =>
        this.outcome(
          await store.persistEvent(
            event as EventEnvelope<ConformanceJsonValue>,
          ),
        ),
      persistEventAndSnapshot: async (event, snapshot) =>
        this.outcome(
          await store.persistEventAndSnapshot(
            event as EventEnvelope<ConformanceJsonValue>,
            snapshot as SnapshotEnvelope<ConformanceJsonValue>,
          ),
        ),
      getLatestSnapshotById: async (id) => {
        const read = await store.getLatestSnapshotById(id);
        if (read.type === "err") return this.outcome(read);
        return {
          kind: "ok",
          value:
            read.value === undefined
              ? { kind: "none" }
              : {
                  kind: "snapshot",
                  headSeqNr: BigInt(read.value.headSeqNr),
                  snapshot:
                    read.value.snapshot === undefined
                      ? null
                      : {
                          aggregateId: id,
                          seqNr: BigInt(read.value.snapshot.seqNr),
                          manifest: read.value.snapshot.manifest,
                          aggregate: read.value.snapshot.aggregate,
                        },
                },
        };
      },
      getEventsByIdSinceSeqNr: async (id, seqNr) => {
        const read = await store.getEventsByIdSinceSeqNr(id, Number(seqNr));
        if (read.type === "err") return this.outcome(read);
        return {
          kind: "ok",
          value: read.value.map((event) => ({
            aggregateId: event.aggregateId,
            seqNr: BigInt(event.seqNr),
            occurredAtEpochNanos:
              BigInt(event.occurredAt.getTime()) * BigInt(1000000),
            manifest: event.manifest,
            payload: event.payload,
          })),
        };
      },
    };
  }

  serializer(
    registry: ConformanceFaultRegistry,
    subject: "event" | "snapshot",
  ) {
    const json = PayloadSerializer.json<ConformanceJsonValue>();
    const run = <T>(phase: string, body: () => T): T => {
      const fault = registry.take(phase);
      if (fault === undefined) return body();
      if (fault.declaration.kind !== "serialization-error")
        throw new Error("unsupported serializer fault");
      if (fault.declaration.injection === "replace-response") body();
      registry.applied(fault.index);
      throw new Error(String(recordOf(fault.declaration.details).message));
    };
    return {
      serialize: (payload: ConformanceJsonValue) =>
        run(`serialize-${subject}`, () => json.serialize(payload)),
      deserialize: (bytes: Uint8Array, manifest: string) =>
        run(`deserialize-${subject}`, () => json.deserialize(bytes, manifest)),
    };
  }
}
