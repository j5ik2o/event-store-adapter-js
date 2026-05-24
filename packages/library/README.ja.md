# event-store-adapter-js

[![CI](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/event-store-adapter-js.svg)](https://badge.fury.io/js/event-store-adapter-js)
[![Renovate](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://renovatebot.com)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![](https://tokei.rs/b1/github/j5ik2o/event-store-adapter-js)](https://github.com/XAMPPRocky/tokei)

このライブラリは、DynamoDBをCQRS/Event Sourcing用のEvent Storeにするためのものです。

[English](./README.md)

# 導入方法

```shell
npm install event-store-adapter-js
```

# 使い方

EventStoreを使えば、Event Sourcing対応リポジトリを簡単に実装できます。

```typescript
const UserAccountRepository = Object.freeze({
    create(eventStore: EventStore<UserAccountId, UserAccount, UserAccountEvent>) {
        return Object.freeze({
            storeEvent: (event: UserAccountEvent, version: number) =>
                eventStore.persistEvent(event, version),
            storeEventAndSnapshot: (event: UserAccountEvent, snapshot: UserAccount) =>
                eventStore.persistEventAndSnapshot(event, snapshot),
            async findById(id: UserAccountId): Promise<UserAccount | undefined> {
                const snapshot = await eventStore.getLatestSnapshotById(id);
                if (snapshot === undefined) {
                    return undefined;
                }
                const events = await eventStore.getEventsByIdSinceSequenceNumber(
                    id,
                    snapshot.sequenceNumber + 1,
                );
                return UserAccount.replay(events, snapshot);
            },
        });
    },
});
```

以下はリポジトリの使用例です。

```typescript
const eventStore = EventStore.createDynamoDB<
    UserAccountId,
    UserAccount,
    UserAccountEvent
>({
    client: dynamodbClient,
    journalTableName: JOURNAL_TABLE_NAME,
    snapshotTableName: SNAPSHOT_TABLE_NAME,
    journalAidIndexName: JOURNAL_AID_INDEX_NAME,
    snapshotAidIndexName: SNAPSHOT_AID_INDEX_NAME,
    snapshotActiveTtlIndexName: SNAPSHOT_ACTIVE_TTL_INDEX_NAME,
    shardCount: 32,
    eventConverter: convertJSONToUserAccountEvent,
    snapshotConverter: convertJSONToUserAccount,
});
// if you want to use in-memory event store, use the following code.
// const eventStore = EventStore.createMemory<UserAccountId, UserAccount, UserAccountEvent>({});
// Cloud Spannerを使う場合は、呼び出し側で管理するDatabaseを渡します。
// const eventStore = EventStore.createSpanner<UserAccountId, UserAccount, UserAccountEvent>({
//     database: spannerDatabase,
//     journalTableName: "journal",
//     snapshotTableName: "snapshot",
//     shardCount: 32,
//     eventConverter: convertJSONToUserAccountEvent,
//     snapshotConverter: convertJSONToUserAccount,
// });

const userAccountRepository = UserAccountRepository.create(eventStore);

const id = UserAccountId.create(ulid());
const name = "Alice";
const [userAccount1, created] = UserAccount.create(id, name);

const createdResult = await userAccountRepository.storeEventAndSnapshot(created, userAccount1);
if (createdResult.type === "err") {
    throw new Error(createdResult.error.message);
}

const [userAccount2, renamed] = userAccount1.rename("Bob");

const renamedResult = await userAccountRepository.storeEvent(renamed, userAccount2.version);
if (renamedResult.type === "err") {
    throw new Error(renamedResult.error.message);
}

const userAccount3 = await userAccountRepository.findById(id);
if (userAccount3 === undefined) {
    throw new Error("userAccount3 is undefined");
}

expect(userAccount3.id).toEqual(id);
expect(userAccount3.name).toEqual("Bob");
expect(userAccount3.sequenceNumber).toEqual(2);
expect(userAccount3.version).toEqual(2);
```

## 開発

このリポジトリは pnpm workspace を使います。ライブラリパッケージは
`packages/library` に配置しています。実行可能な example は `packages/examples` にあり、
`packages/tests` は今後の e2e test package の追加先として予約しています。

```shell
pnpm install
pnpm run lint
pnpm run build
pnpm run test
pnpm run coverage
pnpm run example:memory
pnpm run example:dynamodb
pnpm run example:spanner
```

## テーブル仕様

[docs/DATABASE_SCHEMA.ja.md](docs/DATABASE_SCHEMA.ja.md)を参照してください。

Cloud Spannerについては[docs/SPANNER_DATABASE_SCHEMA.ja.md](docs/SPANNER_DATABASE_SCHEMA.ja.md)を参照してください。

## ライセンス

MIT と Apache-2.0 のデュアルライセンスです。詳細は
[LICENSE-MIT](LICENSE-MIT) と [LICENSE-APACHE](LICENSE-APACHE) を参照してください。

## 他の言語のための実装

- [for Java](https://github.com/j5ik2o/event-store-adapter-java)
- [for Scala](https://github.com/j5ik2o/event-store-adapter-scala)
- [for Kotlin](https://github.com/j5ik2o/event-store-adapter-kotlin)
- [for Rust](https://github.com/j5ik2o/event-store-adapter-rs)
- [for Go](https://github.com/j5ik2o/event-store-adapter-go)
- [for JavaScript/TypeScript](https://github.com/j5ik2o/event-store-adapter-js)
- [for .NET](https://github.com/j5ik2o/event-store-adapter-dotnet)
- [for PHP](https://github.com/j5ik2o/event-store-adapter-php)
