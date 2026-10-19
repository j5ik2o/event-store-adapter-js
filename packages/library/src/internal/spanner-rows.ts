import type { Snapshot } from "@google-cloud/spanner";

/** INT64 を { value: "…" } のまま（number を経由せず）受け取って行を読む。 */
export async function spannerRows(
  source: Snapshot,
  sql: string,
  params?: { readonly [name: string]: unknown },
  types?: { readonly [name: string]: string },
): Promise<readonly Record<string, unknown>[]> {
  const [rows] = await source.run({
    sql,
    ...(params === undefined ? {} : { params: { ...params } }),
    ...(types === undefined ? {} : { types: { ...types } }),
    json: true,
    jsonOptions: { wrapNumbers: true },
  } as Parameters<Snapshot["run"]>[0]);
  return rows as Record<string, unknown>[];
}
