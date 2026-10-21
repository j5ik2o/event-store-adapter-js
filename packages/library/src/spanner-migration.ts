import { migrateV4SpannerInternal } from "./internal/spanner-migration";
import type { Result } from "./result";
import type { SpannerMigrationFailure } from "./spanner-migration-failure";
import type { SpannerMigrationInput } from "./spanner-migration-input";
import type { SpannerMigrationReport } from "./spanner-migration-report";

/**
 * v4 の Spanner（journal / snapshot の 2 テーブル）を、初期化済みの v5 の 5 テーブルへ移す。
 * 検査で拒む理由が 1 つでもあれば、移行先に何も書かない。
 */
export async function migrateV4Spanner<PE = unknown, PS = unknown>(
  input: SpannerMigrationInput<PE, PS>,
): Promise<Result<SpannerMigrationReport, SpannerMigrationFailure>> {
  return migrateV4SpannerInternal(input);
}
