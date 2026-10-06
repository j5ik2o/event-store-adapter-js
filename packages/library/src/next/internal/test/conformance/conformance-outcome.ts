export type ConformanceOutcome<T> =
  | { kind: "ok"; value: T }
  | {
      kind: "error";
      category:
        | "optimistic-lock"
        | "contract-violation"
        | "serialization"
        | "configuration"
        | "storage";
      rule?: string;
      message: string;
    };
