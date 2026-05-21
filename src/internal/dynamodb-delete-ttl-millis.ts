function normalizeDynamoDBDeleteTtlMillis(
  deleteTtlMillis: number | undefined,
): number | undefined {
  if (deleteTtlMillis === undefined) {
    return undefined;
  }
  if (!Number.isFinite(deleteTtlMillis)) {
    throw new Error(`deleteTtlMillis must be finite, got ${deleteTtlMillis}`);
  }
  if (deleteTtlMillis < 0 || Object.is(deleteTtlMillis, -0)) {
    throw new Error(
      `deleteTtlMillis must be non-negative, got ${deleteTtlMillis}`,
    );
  }
  return Math.floor(deleteTtlMillis);
}

export { normalizeDynamoDBDeleteTtlMillis };
