import { statSync } from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";

const MINIMUM_VERSION: readonly number[] = [3, 51, 3];

/** SQLite の版を、部分ごとに整数として比べる（3.100.0 は 3.51.3 より新しい）。 */
export function meetsMinimumSqliteVersion(version: string): boolean {
  const parts = version.split(".");
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) return false;
  const numbers = parts.map(Number);
  for (const [index, minimum] of MINIMUM_VERSION.entries()) {
    if (numbers[index] > minimum) return true;
    if (numbers[index] < minimum) return false;
  }
  return true;
}

type ConnectionRequirement = Readonly<{
  /** 設定の文。版の確認のように設定しないものは省く。 */
  set?: string;
  query: string;
  accepts: (value: unknown) => boolean;
  failure: string;
}>;

const pragmaRequirement = (
  name: string,
  value: string | number,
  accepts: (value: unknown) => boolean,
): ConnectionRequirement => ({
  set: `PRAGMA ${name} = ${value}`,
  query: `PRAGMA ${name}`,
  accepts,
  failure: `PRAGMA ${name} does not have the required value`,
});

/**
 * 接続ごとに満たす条件を、確かめる順に並べる（SQ-1・SQ-14・SQ-15）。
 * 版を最初に確かめる。locking_mode は journal_mode を WAL にする前に NORMAL へ設定する。
 */
const connectionRequirements = (
  lockWaitMilliseconds: number,
): readonly ConnectionRequirement[] => [
  {
    query: "SELECT sqlite_version()",
    accepts: (value) => meetsMinimumSqliteVersion(String(value)),
    failure: "SQLite 3.51.3 or later is required",
  },
  pragmaRequirement(
    "busy_timeout",
    lockWaitMilliseconds,
    (v) => v === lockWaitMilliseconds,
  ),
  pragmaRequirement(
    "locking_mode",
    "NORMAL",
    (v) => String(v).toLowerCase() === "normal",
  ),
  pragmaRequirement(
    "journal_mode",
    "WAL",
    (v) => String(v).toLowerCase() === "wal",
  ),
  pragmaRequirement("synchronous", "FULL", (v) => v === 2),
  pragmaRequirement("read_uncommitted", 0, (v) => v === 0),
];

/**
 * 接続を 1 本開き、版と PRAGMA を設定して読み直す（SQ-1・SQ-14・SQ-15）。
 * "existing" はファイルが無ければ作らず保存先エラーにする。
 * パスは絶対パスにして、URI としては解釈させない。
 */
export function openSqliteConnection(
  file: string,
  lockWaitMilliseconds: number,
  mode: "create" | "existing",
): Result<DatabaseSync, EventStoreError> {
  const absolute = path.resolve(file);
  let db: DatabaseSync | undefined;
  try {
    if (
      mode === "existing" &&
      statSync(absolute, { throwIfNoEntry: false })?.isFile() !== true
    ) {
      return Result.err(
        EventStoreError.storage(`database file does not exist: ${absolute}`),
      );
    }
    db = new DatabaseSync(absolute);
    for (const requirement of connectionRequirements(lockWaitMilliseconds)) {
      if (requirement.set !== undefined) db.exec(requirement.set);
      // どの問い合わせも 1 行 1 列を返す。
      const row = db.prepare(requirement.query).get() as Record<
        string,
        unknown
      >;
      if (!requirement.accepts(Object.values(row)[0])) {
        db.close();
        return Result.err(
          EventStoreError.configuration("database", requirement.failure),
        );
      }
    }
    return Result.ok(db);
  } catch (cause) {
    try {
      db?.close();
    } catch {
      // 開く途中の失敗の後始末。閉じられなくても、報告する原因は元の失敗である。
    }
    return Result.err(
      EventStoreError.storage("SQLite connection could not be opened", cause),
    );
  }
}
