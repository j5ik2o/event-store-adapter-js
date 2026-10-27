> この文書は [README.md](README.md) の日本語版です。英語版が正本で、食い違うときは英語版に従います。

# event-store-adapter-js

[![CI](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/event-store-adapter-js.svg)](https://badge.fury.io/js/event-store-adapter-js)


## 概要

Memory、DynamoDB、SQLite、Spanner、Bigtableのイベントストアです。[共通契約 v5](https://github.com/j5ik2o/event-store-adapter/blob/main/docs/spec/README.md) に従います。メジャーの番号 5 は、共通契約の版と同じです。

[English](./README.md)

## インストール

Node.js 24以降を使用してください。

```shell
npm install event-store-adapter-js
```

## はじめに

メタデータは封筒に置き、payloadにはserializerが扱える任意のドメイン型を使います。シーケンス番号は安全な整数で、書き込みは1から連続します。集約IDは `typeName-value` で構築します。`typeName` に `-` は使えず、集約ID全体のUTF-8サイズは1024バイト以内です。

```typescript
import {
  AggregateId, EventEnvelope, EventStore, SnapshotEnvelope,
  type EventStoreError, type Result,
} from "event-store-adapter-js";

function unwrap<T>(result: Result<T, EventStoreError>): T {
  if (result.type === "err") {
    throw new Error(result.error.message, { cause: result.error });
  }
  return result.value;
}

const store = unwrap(EventStore.createMemory<{ added: number }, { total: number }>());
const id = unwrap(AggregateId.of("Order", "1"));
const event = unwrap(EventEnvelope.create({
  aggregateId: id, seqNr: 1, occurredAt: new Date(),
  manifest: "OrderEvent.v1", payload: { added: 2 },
}));
const snapshot = unwrap(SnapshotEnvelope.create({
  seqNr: 1, manifest: "Order.v1", aggregate: { total: 2 },
}));
unwrap(await store.persistEventAndSnapshot(event, snapshot));
unwrap(await store.persistEvent(unwrap(EventEnvelope.create({
  aggregateId: id, seqNr: 2, occurredAt: new Date(),
  payload: { added: 3 },
}))));

const latest = unwrap(await store.getLatestSnapshotById(id));
const saved = latest?.snapshot;
const events = unwrap(await store.getEventsByIdSinceSeqNr(
  id, saved === undefined ? 1 : saved.seqNr + 1,
));
const total = events.reduce((value, next) => value + next.payload.added, saved?.aggregate.total ?? 0);
// total === 5、latest.headSeqNr === 2、saved.seqNr === 1。
```

headがなければ `getLatestSnapshotById` は `undefined` を返します。headがあれば `{ headSeqNr, snapshot }` を返し、snapshotは省略される場合があります。復元はsnapshot番号＋1、snapshotなしなら1から始めます。head番号は最新の確定イベントを表します。

## 保存先

### メモリ

メモリの保存先は単一プロセスのメモリだけを使います。ファイルへの保存、再起動後の回復、プロセス間の共有はしません。storageを省略したMemory生成は独立します。共有する場合は `MemoryStorage.create()` の同じ値を複数のfactoryへ渡し、保持設定もstorageに指定します。

```typescript
const storage = unwrap(MemoryStorage.create({ retention: { count: 3 } }));
const first = unwrap(EventStore.createMemory({ storage }));
const second = unwrap(EventStore.createMemory({ storage }));
```

### DynamoDB

[DYNAMODB_DATABASE_SCHEMA.ja.md](docs/DYNAMODB_DATABASE_SCHEMA.ja.md) に従い、3表と履歴GSIを作成してからストアを生成します。ライブラリは3表の共通設定項目を作成・照合します。3 つの表は同じリージョンに置き、書き込みもそのリージョンからだけ行ってください。グローバルテーブル（複数リージョンのレプリカ）は範囲外です。

```typescript
const opened = await EventStore.createDynamoDB({
  client: dynamodbClient,
  tables: { journal: "journal", snapshot: "snapshot", head: "head" },
  snapshotAidIndexName: "snapshot-history",
  retention: { count: 3, mode: { type: "delete" } },
  onRetentionFailure: (failure) => console.error(failure.kind, failure.cause),
});
const store = unwrap(opened);
```

AWSクライアントは呼び出し側で管理します。

### SQLite

SQLiteは別の入口 `event-store-adapter-js/sqlite` で提供します。Node.js 24.15以上に同梱の `node:sqlite`（SQLite 3.51.3以上）を使うので、導入するドライバーはありません。元の入口 `event-store-adapter-js` は `node:sqlite` を読み込みません。

空のファイルを `SqliteEventStore.initialize` で一度だけ初期化し、`SqliteEventStore.create` で開きます。`create` はファイルを初期化せず、配置と設定の行を照合するだけです（[SQLITE_DATABASE_SCHEMA.ja.md](docs/SQLITE_DATABASE_SCHEMA.ja.md) を参照）。ファイルが無ければ `storage-error` になります。

```typescript
import {
  SqliteEventStore,
  type SqliteEventStoreInput,
} from "event-store-adapter-js/sqlite";

const input: SqliteEventStoreInput<unknown, unknown> = {
  path: "/var/lib/app/events.sqlite3",
  retention: { count: 3 },
  lockWaitMilliseconds: 5000,
  onRetentionFailure: (failure) => console.error(failure.kind, failure.cause),
};
unwrap(await SqliteEventStore.initialize(input));
const store = unwrap(await SqliteEventStore.create(input));
// ... 4つの操作を使う ...
unwrap(store.close());
```

ストアはファイルへの接続を1本所有します。`close()` は何度呼んでも構いません。閉じた後の操作は `storage-error` になります。`lockWaitMilliseconds` は、追記が別の接続の書き込みロックを待つ時間です（0から2147483647、既定は5000）。超過は `storage-error` で、`optimistic-lock-conflict` にはなりません。`node:sqlite` は同期 API なので、追記がロックを待つあいだはスレッドを占有し、Node.js のイベントループが止まります。サーバーでは短い値にしてください。`retention` は `{ count }` で、`count` は正の整数です。TTL（`mode: { type: "ttl", ... }`）は `configuration-error` になります。この版は変更フィードを提供しません。`changeFeed` を指定すると `configuration-error` になります。ファイルの配置はRust版と同じなので、どちらの実装が書いたファイルも、もう一方で読み書きできます。

### Spanner

Spannerは別の入口 `event-store-adapter-js/spanner` で提供します。Spannerの SDK は利用者が導入してください。任意のpeer依存（`^8.7.1 || ^9.0.0`）です。元の入口 `event-store-adapter-js` は Spanner の SDK を読み込みません。

```shell
npm install event-store-adapter-js @google-cloud/spanner
```

ストアを生成する前に、[SPANNER_DATABASE_SCHEMA.ja.md](docs/SPANNER_DATABASE_SCHEMA.ja.md) の手順で、5つのテーブルと設定の行を作ってください。`SpannerEventStore.create` はDDLを実行せず、テーブルと設定の行を照合するだけです。

```typescript
import { SpannerEventStore } from "event-store-adapter-js/spanner";

const opened = await SpannerEventStore.create({
  database: spannerDatabase,
  tablePrefix: "esa",
  retention: { count: 3, mode: "delete" },
  transactionRetryLimit: 5,
  onRetentionFailure: (failure) => console.error(failure.kind, failure.cause),
});
const store = unwrap(opened);
```

`database` は `@google-cloud/spanner` の `Database` で、`tablePrefix` から5つのテーブル名を導きます。`Database` は呼び出し側が管理し、閉じるのも呼び出し側です。結果は `Result<EventStore, EventStoreError>` で、テーブルや設定の欠けと食い違いは `configuration-error` になります。`retention` は `{ count, mode }` で、`count` は正の整数です。modeは `"delete"`（既定）または `{ type: "ttl", graceDays }`（正の整数の日数）です。`transactionRetryLimit` はABORTEDになったトランザクションの再実行の上限で、既定は5、最初の試行は数えません。

この版は変更フィードを提供しません。`changeFeed` を指定すると `configuration-error` になり、設定の行は `change_feed_enabled` を `FALSE` で記録します。
### Bigtable

Bigtable は別の入口 `event-store-adapter-js/bigtable` にあります。Bigtable の SDK は利用者がインストールします。省略可能な peer 依存（`^7.5.0`）で、主な入口 `event-store-adapter-js` は Bigtable の SDK を読み込みません。

```shell
npm install event-store-adapter-js @google-cloud/bigtable
```

ストアを開く前に、列ファミリ付きの 2 つのテーブルを作ります（手順は [BIGTABLE_DATABASE_SCHEMA.ja.md](docs/BIGTABLE_DATABASE_SCHEMA.ja.md)）。`BigtableEventStore.initialize` は両方のテーブルへ設定行を 1 回だけ書きます。`BigtableEventStore.create` はテーブルも行も作らず、列ファミリと設定行を照合するだけです。初回は新しいストアを用意します。

<!-- bigtable-example:first-run -->
```typescript
import { Bigtable } from "@google-cloud/bigtable";
import {
  BigtableEventStore,
  type BigtableEventStoreInput,
} from "event-store-adapter-js/bigtable";

type OrderEvent = { added: number };
type OrderSnapshot = { total: number };

export async function main(): Promise<number> {
  // Against the real service, pass your projectId and let Google's libraries authenticate. Point at an emulator with BIGTABLE_EMULATOR_HOST.
  const bigtable = new Bigtable({ projectId: "my-project", metricsEnabled: false });
  const input: BigtableEventStoreInput<OrderEvent, OrderSnapshot> = {
    bigtable,
    instanceId: "my-instance",
    tables: { journal: "my-journal-table", head: "my-head-table" },
    retention: { count: 3 },
  };
  try {
    const initialized = await BigtableEventStore.initialize(input);
    if (initialized.type === "err") throw new Error(initialized.error.message);
    const created = await BigtableEventStore.create(input);
    if (created.type === "err") throw new Error(created.error.message);
    const store = created.value;
    const aggregateId = { typeName: "Order", value: "1" };
    const first = await store.persistEventAndSnapshot(
      { aggregateId, seqNr: 1, occurredAt: new Date(), manifest: "OrderEvent.v1", payload: { added: 2 } },
      { seqNr: 1, manifest: "Order.v1", aggregate: { total: 2 } },
    );
    if (first.type === "err") throw new Error(first.error.message);
    const second = await store.persistEvent({
      aggregateId, seqNr: 2, occurredAt: new Date(), manifest: "OrderEvent.v1", payload: { added: 3 },
    });
    if (second.type === "err") throw new Error(second.error.message);
    const events = await store.getEventsByIdSinceSeqNr(aggregateId, 1);
    if (events.type === "err") throw new Error(events.error.message);
    return events.value.length; // 2
  } finally {
    await bigtable.close();
  }
}
```

再起動したら、同じ設定で同じテーブルを開きます。もう一度初期化してはいけません。

<!-- bigtable-example:reopen -->
```typescript
import { Bigtable } from "@google-cloud/bigtable";
import {
  BigtableEventStore,
  type BigtableEventStoreInput,
} from "event-store-adapter-js/bigtable";

type OrderEvent = { added: number };
type OrderSnapshot = { total: number };

export async function main(): Promise<number> {
  const bigtable = new Bigtable({ projectId: "my-project", metricsEnabled: false });
  // Open with the same settings. Do not call initialize again.
  const input: BigtableEventStoreInput<OrderEvent, OrderSnapshot> = {
    bigtable,
    instanceId: "my-instance",
    tables: { journal: "my-journal-table", head: "my-head-table" },
    retention: { count: 3 },
  };
  try {
    const created = await BigtableEventStore.create(input);
    if (created.type === "err") throw new Error(created.error.message);
    const latest = await created.value.getLatestSnapshotById({ typeName: "Order", value: "1" });
    if (latest.type === "err") throw new Error(latest.error.message);
    return latest.value?.headSeqNr ?? 0; // 2
  } finally {
    await bigtable.close();
  }
}
```

`Bigtable` クライアントは呼び出し側が所有し、閉じます。`envelopeLimitBytes`（17 から 8388608、既定は 1048576）は、イベントやスナップショットが作る封筒の最大バイト数です。超えると規則 `BT-16` の `contract-violation` になります。この値は設定行に記録されるので、別の値で開くと `configuration-error` です。`retention` は `{ count }` で、TTL は `configuration-error` です。この版は変更フィードを提供しないので、`changeFeed` を渡すと `configuration-error` です。要求ごとに認証するときは `accessToken` を渡します。データと管理のすべての要求の直前に 1 回呼ばれ、結果が `authorization: Bearer <トークン>` として送られます。失敗したときや、ヘッダーにできない値を返したときは、要求を送らず `storage-error` になります。追記の確定後に、新しい末尾の行を journal へ書き出せなかった失敗は、`onJournalWriteFailure` と logger に通知され、追記は成功のままです。行の配置は Rust 版と同じなので、どちらの実装も同じテーブルを読み書きできます。

## 直列化

既定の `PayloadSerializer.json()` はJSON値だけを扱います。任意の同期 `PayloadSerializer<P>` は `serialize(payload): Uint8Array` と `deserialize(bytes, manifest): P` を実装します。payloadだけを直列化し、クラスやbrandは `deserialize` で復元してください。実例の [domain serializer](../examples/src/domain/user-account-serializers.ts) を参照できます。

JavaScriptの時刻はミリ秒精度の `Date` です。DynamoDBのイベント時刻は完全なエポックミリ秒値からナノ秒へ変換して保存します。ミリ秒未満の精度はこのAPIで表現できません。

## 保持

snapshotの書き込み成功後に保持処理を行い、DynamoDBのevent-only書き込みでは保持要求を送りません。保持失敗でも確定済み書き込みは成功し、loggerと `onRetentionFailure` へ通知します。

- DynamoDB: `retention: { count, mode }` を指定します。TTL方式は `mode: { type: "ttl", graceSeconds: 3600 }` とし、snapshot表の `ttl` を有効化してください。
- SQLite: `retention` は `{ count }` です。追記の確定直後に別のトランザクションで、新しい `count` 件のスナップショットだけを履歴に残します。失敗はloggerと `onRetentionFailure` へ通知します。TTLには対応しません。
- Bigtable: `retention` は `{ count }` です。追記の確定直後に別の手順で、新しい `count` 件のスナップショットだけを履歴に残します。失敗はloggerと `onRetentionFailure` へ通知します。TTLには対応しません。
- Spanner: `retention` は `{ count, mode }` で、`count` は正の整数です。modeは `"delete"`（既定）または `{ type: "ttl", graceDays }` です。スナップショットの書き込みが成功した後の保持の失敗は、loggerと `onRetentionFailure` へ通知します。
- Memory: 共有する `MemoryStorage` に保持設定を指定します。Memoryは削除方式の保持に対応し、保持失敗で残った履歴は後のevent-only書き込みでも処理します。TTLには対応しません。

## エラー

両factoryと4操作はすべて `Result` を返します。DynamoDB生成は非同期です。エラーは `contract-violation`（`rule` 付き）、`optimistic-lock-conflict`、`serialization-error`、`configuration-error`、`storage-error` の5分類で、元の `cause` がある場合は保持します。

## 移行

既存データを新しい表へ移す際は [JavaScript移行ガイド](docs/MIGRATION_GUIDE.ja.md) を参照してください。旧shard・version・converter・serializer APIはこの公開入口に含みません。Spannerは `event-store-adapter-js/spanner`、SQLiteは `event-store-adapter-js/sqlite` の入口で提供し、元の入口は Spanner の SDK も `node:sqlite` も読み込みません。旧版にSQLiteの保存先はないので、移行するデータはありません。[SQLite: 新規導入](docs/MIGRATION_GUIDE.ja.md#sqlite-新規導入) を参照してください。Bigtableは `event-store-adapter-js/bigtable` の入口で提供し、元の入口は Bigtable の SDK も読み込みません。旧版にBigtableの保存先はないので、移行するデータも移行ツールもありません。[Bigtable: 新規導入](docs/MIGRATION_GUIDE.ja.md#bigtable-新規導入) を参照してください。

v4 の Spanner アダプタ（`journal` と `snapshot` の 2 テーブル）のデータを移すには、同じ入口の `migrateV4Spanner` を使います。先に全行を検査し、拒む理由が 1 件でもあれば何も書きません。手順は [Spanner 4.x から v5 の Spanner へ](docs/MIGRATION_GUIDE.ja.md#spanner-4x-から-v5-の-spanner-へ) を参照してください。

## 適合

リポジトリのrootで実行します。

```shell
pnpm install
pnpm run build
pnpm run lint
pnpm run test:packages
pnpm run test:examples
pnpm run coverage --runInBand
pnpm run example:memory
pnpm run example:dynamodb
```

DynamoDB試験と実例はTestcontainersからDynamoDB Local 3.3.1を起動するためDockerが必要です。Spanner試験もTestcontainersからCloud Spannerエミュレーターを起動するため、Dockerが必要です。Bigtable試験もTestcontainersからCloud Bigtableエミュレーターを起動するため、Dockerが必要です。SQLite試験はローカルのファイルだけを使い、Dockerは不要で、Node.js 24.15以上が必要です。package試験はpack成果物を独立した外部プロジェクトへ導入し、型検査と実行も行います。全適合の結果はlibraryの `coverage/conformance` へ保存します。`CONFORMANCE_REPORT_DIR` で保存先を指定できます。

## ライセンス

MITとApache-2.0のデュアルライセンスです。[LICENSE-MIT](LICENSE-MIT) と [LICENSE-APACHE](LICENSE-APACHE) を参照してください。

[共通文書](https://github.com/j5ik2o/event-store-adapter)
