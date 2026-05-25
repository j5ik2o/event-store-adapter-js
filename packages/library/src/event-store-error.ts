export type EventStoreError =
  | {
      type: "optimistic-lock-conflict";
      message: string;
      cause?: unknown;
    }
  | {
      type: "configuration-error";
      fieldName: string;
      message: string;
      cause?: unknown;
    }
  | {
      type: "serialization-error";
      operation: "serialize" | "deserialize";
      message: string;
      cause?: unknown;
    }
  | {
      type: "storage-error";
      message: string;
      cause?: unknown;
    };

export namespace EventStoreError {
  export function optimisticLockConflict(
    message = "Optimistic locking failed",
    cause?: unknown,
  ): EventStoreError {
    return Object.freeze({
      type: "optimistic-lock-conflict",
      message,
      cause,
    });
  }

  export function configuration(
    fieldName: string,
    message: string,
    cause?: unknown,
  ): EventStoreError {
    return Object.freeze({
      type: "configuration-error",
      fieldName,
      message,
      cause,
    });
  }

  export function serialization(
    operation: "serialize" | "deserialize",
    message: string,
    cause?: unknown,
  ): EventStoreError {
    return Object.freeze({
      type: "serialization-error",
      operation,
      message,
      cause,
    });
  }

  export function storage(message: string, cause?: unknown): EventStoreError {
    return Object.freeze({
      type: "storage-error",
      message,
      cause,
    });
  }
}

// Object.freeze mutates the existing EventStoreError namespace object in place;
// the returned reference is intentionally ignored to preserve the public binding.
Object.freeze(EventStoreError);
