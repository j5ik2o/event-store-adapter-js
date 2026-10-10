const OCCURRED_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{9})Z$/;
const NANOS_PER_MILLI = BigInt(1000000);

export function nativeTimeEpochNanos(ns: bigint): bigint {
  const quotient = ns / NANOS_PER_MILLI;
  return (
    (ns % NANOS_PER_MILLI < BigInt(0) ? quotient - BigInt(1) : quotient) *
    NANOS_PER_MILLI
  );
}

export function parseOccurredAtEpochNanos(iso: string): bigint {
  const match = OCCURRED_AT_PATTERN.exec(iso);
  if (match === null) {
    throw new Error(`invalid occurred_at: ${iso}`);
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((s) => Number(s));
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new Error(`invalid occurred_at: ${iso}`);
  }
  return BigInt(ms) * NANOS_PER_MILLI + BigInt(match[7]);
}

export function parseEpochNanos(text: string): bigint {
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`invalid epoch nanoseconds: ${text}`);
  }
  return BigInt(text);
}
