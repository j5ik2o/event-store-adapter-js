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

function pragmaValue(db: DatabaseSync, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

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
    const version = String(
      (db.prepare("SELECT sqlite_version() AS v").get() as { v: unknown }).v,
    );
    if (!meetsMinimumSqliteVersion(version)) {
      db.close();
      return Result.err(
        EventStoreError.configuration(
          "database",
          `SQLite 3.51.3 or later is required, but the bundled version is ${version}`,
        ),
      );
    }
    db.exec(`PRAGMA busy_timeout = ${lockWaitMilliseconds}`);
    db.exec("PRAGMA locking_mode = NORMAL");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA read_uncommitted = 0");
    const expected: readonly [string, (value: unknown) => boolean][] = [
      ["busy_timeout", (v) => v === lockWaitMilliseconds],
      ["locking_mode", (v) => String(v).toLowerCase() === "normal"],
      ["journal_mode", (v) => String(v).toLowerCase() === "wal"],
      ["synchronous", (v) => v === 2],
      ["read_uncommitted", (v) => v === 0],
    ];
    for (const [name, accepts] of expected) {
      if (!accepts(pragmaValue(db, name))) {
        db.close();
        return Result.err(
          EventStoreError.configuration(
            "database",
            `PRAGMA ${name} does not have the required value`,
          ),
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
