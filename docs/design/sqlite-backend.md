# Design of the SQLite Storage

This document is the design record of the SQLite storage in `event-store-adapter-js`. Check the [README](../../packages/library/README.md) and the [schema document](../../packages/library/docs/SQLITE_DATABASE_SCHEMA.md) for current usage.

- Normative sources: the hub (j5ik2o/event-store-adapter) `docs/spec/core-contract.md` and `docs/spec/storage/sqlite.md` (v5). This document adds no rules and changes no specification. Rule numbers (SQ-1, W-8, etc.) are the numbers in those sources.
- Conformance data: `conformance/` (v1.3.0). The 42 common scenarios, the 7 SQLite scenarios and the 1 shared scenario are all run against the SQLite storage (`packages/library/src/internal/test/conformance/conformance-sqlite.test.ts`). The 4 nanosecond-precision scenarios are the only exclusion (`Date` has millisecond precision); 68 required cases pass, with no failed, unverified or not-representable case.
- Paths below are relative to `packages/library/src/`. "Test" means a jest test in that file.

## 1. Decisions

| Decision | Choice | Reason |
|:--|:--|:--|
| Driver | `node:sqlite` bundled with Node.js 24.15 or later (SQLite 3.51.3 or later; 3.53.4 on Node.js 24.22) | No dependency and no native build. `BigInt` reads and writes, and `isTransaction`, are available. |
| Entry point | `event-store-adapter-js/sqlite`, separate from the main entry | The main entry must not load `node:sqlite` (the same approach as Spanner). |
| Connection ownership | The library takes `path`, opens one connection per store, and returns `close()` | Prevents URI interpretation, shared caches, `ATTACH` and TEMP tables from changing the table names the library sees. |
| Initialization | `SqliteEventStore.initialize` and `SqliteEventStore.create` are separate (SQ-D6) | `create` never creates or completes a layout. |
| Transactions | Every transaction runs synchronously, without `await` | The one connection is never handed to another operation in the middle of one (SQ-5, SQ-17). |
| Head | Read in every operation, never cached | Another connection or process may have committed. |
| Retention type | The existing `SnapshotRetention`; TTL is a `configuration-error` | Same type and same treatment as the memory storage (SQ-11). |
| `aid` collation | Read the column's declared collation by tokenizing `sqlite_schema.sql`, and the primary key index collation with `pragma_index_xinfo`; both must be `BINARY` | Node.js has no column metadata API. Both are needed because a `NOCASE` column with a `BINARY` primary key index reads `User-A` and `User-a` as one aggregate. |
| Exclusions | Change feed (SQ-12, SQ-13, SQ-18) is not provided in the first version (SQ-D8). Request splitting (paging) is not needed because every SQLite statement runs on the local file. A migration tool is not provided because earlier versions had no SQLite storage. | |

## 2. Rule-to-test mapping

| Rule | Behavior | Test |
|:--|:--|:--|
| SQ-1, SQ-14, SQ-15 | Version check (part-by-part integer comparison); `busy_timeout`, `locking_mode`, `journal_mode`, `synchronous`, `read_uncommitted` set and read back; an omitted `lockWaitMilliseconds` resolves to the default 5000 | `internal/sqlite-connection.test.ts`: `meetsMinimumSqliteVersion`, `openSqliteConnection`; `internal/sqlite-event-store-input-validation.test.ts`: "resolves an omitted lockWaitMilliseconds to the documented default 5000 (SQ-1)" |
| SQ-2, SQ-19 | Recorded configuration is compared with the client's settings; mismatches are a `configuration-error` and no table or row is modified. The one exception: every connection sets `journal_mode = WAL` when the file is opened, before the layout and configuration are compared (SQ-1, SQ-14), so a rejected file whose `journal_mode` was not `wal` is switched to WAL | `internal/sqlite-store-configuration.test.ts`: "recorded configuration against the client (SQ-2, SQ-19)", "opening a rejected file (SQ-1, SQ-14, SQ-2)" (tables and rows unchanged, `journal_mode` switched from `delete` to `wal`); conformance `sqlite-seeded-*` |
| SQ-2 (aid collation) | Column and primary key index must both be `BINARY`; a mis-configured file is rejected on open and its tables and rows are left unchanged (only `journal_mode` may switch to WAL, as above); the default and explicit `BINARY` are accepted | `internal/sqlite-layout.test.ts`: "aid collation (SQ-2)"; `internal/sqlite-column-collation.test.ts` |
| SQ-3, SQ-4 | Integers bound and read as `BigInt` (`typeof` is integer, text, blob); nanoseconds round toward negative infinity; `aid` compared exactly (`User-A`, `User-a`, `Order-%`) | `internal/sqlite-event-store.test.ts`: "stored values (SQ-VALUES)" |
| SQ-5, SQ-17 | `BEGIN IMMEDIATE` before the head read, on one connection, without `await` | `internal/sqlite-event-store.test.ts`: "the head is read after BEGIN IMMEDIATE has taken the write lock (SQ-5, SQ-17)" |
| SQ-6 | Errors before `COMMIT` are rolled back; a failure of `COMMIT` is a `storage-error` and the library does not renumber | `internal/sqlite-event-store.test.ts`: "a failure after the journal and head rows were written rolls everything back (SQ-6)", "a failure just before COMMIT is a storage error…" |
| SQ-7 | Busy and lock-wait overruns are a `storage-error`, never an optimistic lock conflict; the wait lasts `lockWaitMilliseconds` | `internal/sqlite-concurrency.test.ts`: "lock wait (SQ-7, SQ-1)"; conformance `sqlite-write-lock-busy` |
| W-8 (another process) | An append that waited for a commit of seq 2 by another process is an `optimistic-lock-conflict` | `internal/sqlite-concurrency.test.ts`: "another process (W-8, SQ-5)" |
| SQ-8, SQ-9 | The latest snapshot and the events are each read in one read transaction; a commit in the middle is not mixed in | `internal/sqlite-event-store.test.ts`: "read (SQ-READ)" |
| SQ-10 | Right after the commit, a separate `BEGIN IMMEDIATE` keeps the newest n history rows | `internal/sqlite-snapshot-retention.test.ts`: "successful retention (SQ-10)" |
| SQ-11 | A cleanup failure is rolled back and reported through the logger and `onRetentionFailure`; the append stays successful even if a notification path throws or rejects (the tests assert the paths were called); TTL is a `configuration-error` | `internal/sqlite-snapshot-retention.test.ts`: "retention failure (SQ-11, S-4)"; `internal/sqlite-event-store-input-validation.test.ts`; conformance `sqlite-ttl-unsupported` |
| SQ-16 | Every table is `STRICT`; a non-`STRICT` table or a changed column is a `configuration-error` | `internal/sqlite-layout.test.ts`: `createSqliteTables`, `verifySqliteLayout` |
| SQ-20 | A `changeFeed` setting or a recorded `change_feed_enabled` of 1 is a `configuration-error`; `head_transition` is not created | `internal/sqlite-event-store.test.ts`: "initialize and create"; conformance `sqlite-change-feed-unsupported`, `sqlite-seeded-change-feed-enabled` |
| SQ-D6 | `create` never initializes; `initialize` refuses a file that already holds objects | `internal/sqlite-event-store.test.ts`: "initialize and create (SQ-INIT, SQ-OPEN)" |
| SQ-12, SQ-13, SQ-18 | Change feed: not provided in the first version (SQ-D8) | Not applicable |
| Format compatibility | A file written with the Rust DDL and value shapes is read by this storage; rows written by this storage have the Rust shape; the layouts compare equal by pragma | `internal/sqlite-rust-layout.test.ts` |
| Entry point | `./sqlite` export, isolation from the main entry, packed package type-check and execution | `sqlite.test.ts`, `sqlite-package.test.ts`, `sqlite-entry-isolation.test.ts`, `packages/tests/e2e/sqlite-entry-isolation.test.cjs`, `packages/tests/e2e/external-consumption.test.cjs` |

## 3. Conformance run

`pnpm --filter event-store-adapter-js run coverage --runInBand` writes `sqlite.json` next to the memory, DynamoDB and Spanner reports in `coverage/conformance` (or `CONFORMANCE_REPORT_DIR`). `conformance-sqlite.test.ts` fails when a required case is not run, failed, unverified or not representable. The harness runs every case on a temporary file and deletes it afterwards; no external service is used.
