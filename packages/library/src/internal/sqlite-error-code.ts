/** node:sqlite のエラーが持つ SQLite の結果コード（拡張コードを含む）を読む。 */
export function sqliteErrorCode(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = (cause as { errcode?: unknown }).errcode;
  return typeof code === "number" ? code : undefined;
}
