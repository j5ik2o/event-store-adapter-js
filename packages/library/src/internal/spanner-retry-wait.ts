import { performance } from "node:perf_hooks";
import { Root } from "protobufjs/light";
import type { RetryClock } from "./retry-clock";
import type { RetryWait } from "./retry-wait";
import { retryInfoSchema } from "./spanner-retry-info-schema";
import { validateRetryInfoWire } from "./spanner-retry-info-wire";

export const retryClock: RetryClock = {
  random: () => Math.random(),
  now: () => performance.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

const retryInfo = Root.fromJSON(retryInfoSchema).lookupType(
  "google.rpc.RetryInfo",
);

function secondsInteger(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value))
    return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))
    return BigInt(value);
  return undefined;
}

export function durationWait(duration: unknown): RetryWait | undefined {
  if (typeof duration !== "object" || duration === null) return undefined;
  const seconds = secondsInteger("seconds" in duration ? duration.seconds : 0);
  const nanos = "nanos" in duration ? duration.nanos : 0;
  if (
    seconds === undefined ||
    seconds < BigInt(0) ||
    seconds > BigInt(315576000000) ||
    typeof nanos !== "number" ||
    !Number.isInteger(nanos) ||
    nanos < 0 ||
    nanos > 999999999
  )
    return undefined;
  const milliseconds =
    seconds * BigInt(1000) + (BigInt(nanos) + BigInt(999999)) / BigInt(1000000);
  return milliseconds > BigInt(60000)
    ? { kind: "stop" }
    : { kind: "server", milliseconds: Math.max(1, Number(milliseconds)) };
}

function serverWait(cause: unknown): RetryWait | undefined {
  try {
    if (typeof cause !== "object" || cause === null || !("metadata" in cause))
      return undefined;
    const metadata = cause.metadata;
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("get" in metadata) ||
      typeof metadata.get !== "function"
    )
      return undefined;
    const entries: unknown = metadata.get("google.rpc.retryinfo-bin");
    if (!Array.isArray(entries)) return undefined;
    for (const entry of entries) {
      if (!(entry instanceof Uint8Array)) continue;
      try {
        validateRetryInfoWire(entry);
        // String conversion preserves the decoder's int64 Long without rounding.
        const decoded: unknown = retryInfo.toObject(retryInfo.decode(entry), {
          longs: String,
        });
        if (
          typeof decoded !== "object" ||
          decoded === null ||
          !("retryDelay" in decoded)
        )
          continue;
        const wait = durationWait(decoded.retryDelay);
        if (wait) return wait;
      } catch {
        // Invalid metadata must not replace the original ABORTED failure.
      }
    }
  } catch {
    // Metadata access failure has the same fallback as absent metadata.
  }
  return undefined;
}

export function decideRetryWait(
  cause: unknown,
  ordinal: number,
  random: () => number,
): RetryWait {
  const server = serverWait(cause);
  if (server) return server;
  const cap = ordinal >= 6 ? 1000 : 50 * 2 ** (ordinal - 1);
  const floor = Math.ceil(cap / 2);
  return {
    kind: "fallback",
    milliseconds: floor + Math.floor(random() * (cap - floor + 1)),
  };
}

export async function waitForRetry(
  milliseconds: number,
  clock: RetryClock,
): Promise<void> {
  const started = clock.now();
  let remaining = milliseconds;
  do {
    await clock.sleep(Math.min(60000, Math.max(1, Math.ceil(remaining))));
    remaining = milliseconds - (clock.now() - started);
  } while (remaining > 0);
}
