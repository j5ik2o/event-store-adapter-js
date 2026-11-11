export type RetryWait =
  | { kind: "server" | "fallback"; milliseconds: number }
  | { kind: "stop" };
