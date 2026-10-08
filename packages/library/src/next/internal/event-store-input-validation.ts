import { Result } from "../../result";
import { EventStoreError } from "../event-store-error";
import type { MemoryEventStoreInput } from "../memory-event-store-input";
import { PayloadSerializer } from "../payload-serializer";

type EventStoreInput<PE, PS> = Pick<
  MemoryEventStoreInput<PE, PS>,
  "eventSerializer" | "snapshotSerializer" | "onRetentionFailure" | "logger"
>;

function validateSerializer<P>(
  serializer: PayloadSerializer<P> | undefined,
  fieldName: string,
): Result<PayloadSerializer<P>, EventStoreError> {
  if (serializer === undefined) return Result.ok(PayloadSerializer.json<P>());
  if (
    serializer === null ||
    (typeof serializer !== "object" && typeof serializer !== "function")
  ) {
    return Result.err(
      EventStoreError.configuration(fieldName, "serializer must have methods"),
    );
  }
  const { serialize, deserialize } = serializer;
  if (typeof serialize !== "function" || typeof deserialize !== "function") {
    return Result.err(
      EventStoreError.configuration(
        fieldName,
        "serializer.serialize and serializer.deserialize must be functions",
      ),
    );
  }
  return Result.ok(serializer);
}

export function validateEventStoreInput<PE, PS>(
  input?: EventStoreInput<PE, PS>,
): Result<
  Readonly<
    EventStoreInput<PE, PS> & {
      eventSerializer: PayloadSerializer<PE>;
      snapshotSerializer: PayloadSerializer<PS>;
    }
  >,
  EventStoreError
> {
  if (
    input === null ||
    (input !== undefined && (typeof input !== "object" || Array.isArray(input)))
  ) {
    return Result.err(
      EventStoreError.configuration("input", "input must be an object"),
    );
  }
  const {
    eventSerializer: inputEventSerializer,
    snapshotSerializer: inputSnapshotSerializer,
    onRetentionFailure,
    logger,
  } = input ?? {};
  const eventSerializer = validateSerializer(
    inputEventSerializer,
    "eventSerializer",
  );
  if (eventSerializer.type === "err") return eventSerializer;
  const snapshotSerializer = validateSerializer(
    inputSnapshotSerializer,
    "snapshotSerializer",
  );
  if (snapshotSerializer.type === "err") return snapshotSerializer;
  if (
    onRetentionFailure !== undefined &&
    typeof onRetentionFailure !== "function"
  ) {
    return Result.err(
      EventStoreError.configuration(
        "onRetentionFailure",
        "onRetentionFailure must be a function",
      ),
    );
  }
  if (logger !== undefined) {
    if (
      logger === null ||
      (typeof logger !== "object" && typeof logger !== "function")
    ) {
      return Result.err(
        EventStoreError.configuration("logger", "logger must have methods"),
      );
    }
    const { trace, debug, info, warn, error } = logger;
    if (
      (trace !== undefined && typeof trace !== "function") ||
      typeof debug !== "function" ||
      typeof info !== "function" ||
      typeof warn !== "function" ||
      typeof error !== "function"
    ) {
      return Result.err(
        EventStoreError.configuration("logger", "logger methods are invalid"),
      );
    }
  }
  return Result.ok(
    Object.freeze({
      eventSerializer: eventSerializer.value,
      snapshotSerializer: snapshotSerializer.value,
      ...(onRetentionFailure !== undefined ? { onRetentionFailure } : {}),
      ...(logger !== undefined ? { logger } : {}),
    }),
  );
}
