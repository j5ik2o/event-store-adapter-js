function normalizeDynamoDBDeleteTtlMillis(
  deleteTtlMillis: number | undefined,
): number | undefined {
  if (deleteTtlMillis === undefined) {
    return undefined;
  }
  if (!Number.isFinite(deleteTtlMillis)) {
    throw new Error(
      `deleteTtlMillis must be finite, got ${formatDeleteTtlMillis(
        deleteTtlMillis,
      )}`,
    );
  }
  if (deleteTtlMillis < 0 || Object.is(deleteTtlMillis, -0)) {
    throw new Error(
      `deleteTtlMillis must be non-negative, got ${formatDeleteTtlMillis(
        deleteTtlMillis,
      )}`,
    );
  }
  return Math.floor(deleteTtlMillis);
}

function formatDeleteTtlMillis(deleteTtlMillis: number): string {
  return Object.is(deleteTtlMillis, -0) ? "-0" : String(deleteTtlMillis);
}

export { normalizeDynamoDBDeleteTtlMillis };
