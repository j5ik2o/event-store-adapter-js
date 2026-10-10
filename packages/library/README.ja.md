# event-store-adapter-js

[![CI](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/event-store-adapter-js.svg)](https://badge.fury.io/js/event-store-adapter-js)

共通v4契約に従うMemoryとDynamoDBのイベントストアです。共通契約の版とnpmパッケージの版は別です。

[English](./README.md)

## 導入

Node.js 24以降を使用してください。

```shell
npm install event-store-adapter-js
```

## 使い方

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

両factoryと4操作はすべて `Result` を返します。DynamoDB生成は非同期です。エラーは `contract-violation`（`rule` 付き）、`optimistic-lock-conflict`、`serialization-error`、`configuration-error`、`storage-error` の5分類で、元の `cause` がある場合は保持します。

## DynamoDB

[DATABASE_SCHEMA.ja.md](docs/DATABASE_SCHEMA.ja.md) に従い、3表と履歴GSIを作成してからストアを生成します。ライブラリは3表の共通設定項目を作成・照合します。

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

AWSクライアントは呼び出し側で管理します。snapshot書き込み成功後に保持処理を行い、DynamoDBのevent-only書き込みでは保持要求を送りません。保持失敗でも確定済み書き込みは成功し、loggerと `onRetentionFailure` へ通知します。TTL方式は `mode: { type: "ttl", graceSeconds: 3600 }` とし、snapshot表の `ttl` を有効化してください。

## SerializerとMemoryの共有

既定の `PayloadSerializer.json()` はJSON値だけを扱います。任意の同期 `PayloadSerializer<P>` は `serialize(payload): Uint8Array` と `deserialize(bytes, manifest): P` を実装します。payloadだけを直列化し、クラスやbrandは `deserialize` で復元してください。実例の [domain serializer](../examples/src/domain/user-account-serializers.ts) を参照できます。

storageを省略したMemory生成は独立します。共有する場合は `MemoryStorage.create()` の同じ値を複数のfactoryへ渡し、保持設定もstorageに指定します。

```typescript
const storage = unwrap(MemoryStorage.create({ retention: { count: 3 } }));
const first = unwrap(EventStore.createMemory({ storage }));
const second = unwrap(EventStore.createMemory({ storage }));
```

Memoryは削除方式の保持に対応し、保持失敗で残った履歴は後のevent-only書き込みでも処理します。TTLには対応しません。JavaScriptの時刻はミリ秒精度の `Date` です。DynamoDBのイベント時刻は完全なエポックミリ秒値からナノ秒へ変換して保存します。ミリ秒未満の精度はこのAPIで表現できません。

## 移行と開発

既存データを新しい表へ移す際は [JavaScript移行ガイド](docs/MIGRATION_GUIDE.ja.md) を参照してください。Spannerと旧shard・version・converter・serializer APIはこの公開入口に含みません。

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

DynamoDB試験と実例はTestcontainersからDynamoDB Local 3.3.1を起動するためDockerが必要です。package試験はpack成果物を独立した外部プロジェクトへ導入し、型検査と実行も行います。全適合の結果はlibraryの `coverage/conformance` へ保存します。`CONFORMANCE_REPORT_DIR` で保存先を指定できます。

## ライセンス

MITとApache-2.0のデュアルライセンスです。[LICENSE-MIT](LICENSE-MIT) と [LICENSE-APACHE](LICENSE-APACHE) を参照してください。

[共通文書](https://github.com/j5ik2o/event-store-adapter)
