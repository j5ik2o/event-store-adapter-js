import type { DatabaseSync } from "node:sqlite";

/**
 * 開いているトランザクションがあれば ROLLBACK で終える。読み取りでは何も失わず、
 * 書き込みでは確定前の変更を捨てる。ROLLBACK 自体が失敗しても、報告する原因は元の失敗なので握りつぶす。
 */
export function endSqliteTransaction(db: DatabaseSync): void {
  try {
    if (db.isTransaction) db.exec("ROLLBACK");
  } catch {
    // 元の失敗を報告する。ここで失敗しても、確定していない変更が公開されることはない。
  }
}
