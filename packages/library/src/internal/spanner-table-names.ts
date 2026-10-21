import { EventStoreError } from "../event-store-error";
import { Result } from "../result";

export type SpannerTableNames = Readonly<{
  journal: string;
  head: string;
  snapshotCurrent: string;
  snapshotHistory: string;
  config: string;
}>;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Spanner の識別子は 128 文字まで
const MAX_IDENTIFIER_LENGTH = 128;

/** SQL の識別子として使える名前か。文字列で、規則に合い、128 文字以下であること。 */
export function isSpannerIdentifier(name: unknown): name is string {
  return (
    typeof name === "string" &&
    IDENTIFIER.test(name) &&
    name.length <= MAX_IDENTIFIER_LENGTH
  );
}

/** 同じ接頭辞から 5 テーブルの名前を一括して導き、SQL の識別子として検査する。 */
export function spannerTableNames(
  prefix: unknown,
): Result<SpannerTableNames, EventStoreError> {
  if (typeof prefix !== "string" || prefix.length === 0) {
    return Result.err(
      EventStoreError.configuration(
        "tablePrefix",
        "tablePrefix must be a non-empty string",
      ),
    );
  }
  const names: SpannerTableNames = Object.freeze({
    journal: `${prefix}_journal`,
    head: `${prefix}_head`,
    snapshotCurrent: `${prefix}_snapshot_current`,
    snapshotHistory: `${prefix}_snapshot_history`,
    config: `${prefix}_config`,
  });
  if (!Object.values(names).every(isSpannerIdentifier)) {
    return Result.err(
      EventStoreError.configuration(
        "tablePrefix",
        "tablePrefix must form SQL identifiers of at most 128 characters",
      ),
    );
  }
  return Result.ok(names);
}
