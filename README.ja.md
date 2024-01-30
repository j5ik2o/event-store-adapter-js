# event-store-adapter-js

[![CI](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml/badge.svg)](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/event-store-adapter-js.svg)](https://badge.fury.io/js/event-store-adapter-js)
[![Renovate](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://renovatebot.com)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![](https://tokei.rs/b1/github/j5ik2o/event-store-adapter-js)](https://github.com/XAMPPRocky/tokei)

このライブラリは、DynamoDBをCQRS/Event Sourcing用のEvent Storeにするためのものです。

[English](./README.md)

# 導入方法

```shell
$ npm install event-store-adapter-js
```

# 使い方

EventStoreを使えば、Event Sourcing対応リポジトリを簡単に実装できます。

```typescript
class UserAccountRepository {
    constructor(
        private readonly eventStore: EventStore<
            UserAccountId,
            UserAccount,
            UserAccountEvent
        >,
    ) {}

    async storeEvent(event: UserAccountEvent, version: number) {
        await this.eventStore.persistEvent(event, version);
    }

    async storeEventAndSnapshot(event: UserAccountEvent, snapshot: UserAccount) {
        await this.eventStore.persistEventAndSnapshot(event, snapshot);
    }

    async findById(id: UserAccountId): Promise<UserAccount | undefined> {
        const snapshot = await this.eventStore.getLatestSnapshotById(
            id,
        );
        if (snapshot === undefined) {
            return undefined;
        } else {
            const events = await this.eventStore.getEventsByIdSinceSequenceNumber(
                id,
                snapshot.sequenceNumber + 1,
            );
            return UserAccount.replay(events, snapshot);
        }
    }
}
```

以下はリポジトリの使用例です。

```typescript
const eventStore = EventStoreFactory.ofDynamoDB<
    UserAccountId,
    UserAccount,
    UserAccountEvent
>(
    dynamodbClient,
    JOURNAL_TABLE_NAME,
    SNAPSHOT_TABLE_NAME,
    JOURNAL_AID_INDEX_NAME,
    SNAPSHOTS_AID_INDEX_NAME,
    32,
    convertJSONtoUserAccountEvent,
    convertJSONToUserAccount,
);
// if you want to use in-memory event store, use the following code.
// const eventStore = EventStoreFactory.ofMemory<UserAccountId, UserAccount, UserAccountEvent>();

const userAccountRepository = new UserAccountRepository(eventStore);

const id = new UserAccountId(ulid());
const name = "Alice";
const [userAccount1, created] = UserAccount.create(id, name);

await userAccountRepository.storeEventAndSnapshot(created, userAccount1);

const [userAccount2, renamed] = userAccount1.rename("Bob");

await userAccountRepository.storeEvent(renamed, userAccount2.version);

const userAccount3 = await userAccountRepository.findById(id);
if (userAccount3 === undefined) {
    throw new Error("userAccount3 is undefined");
}

expect(userAccount3.id).toEqual(id);
expect(userAccount3.name).toEqual("Bob");
expect(userAccount3.sequenceNumber).toEqual(2);
expect(userAccount3.version).toEqual(2);
```

## テーブル仕様

[docs/DATABASE_SCHEMA.ja.md](docs/DATABASE_SCHEMA.ja.md)を参照してください。

## ライセンス

MITライセンスです。詳細は[LICENSE](LICENSE)を参照してください。

## 他の言語のための実装

- [for Java](https://github.com/j5ik2o/event-store-adapter-java)
- [for Scala](https://github.com/j5ik2o/event-store-adapter-scala)
- [for Kotlin](https://github.com/j5ik2o/event-store-adapter-kotlin)
- [for Rust](https://github.com/j5ik2o/event-store-adapter-rs)
- [for Go](https://github.com/j5ik2o/event-store-adapter-go)
- [for JavaScript/TypeScript](https://github.com/j5ik2o/event-store-adapter-js)
- [for .NET](https://github.com/j5ik2o/event-store-adapter-dotnet)
- [for PHP](https://github.com/j5ik2o/event-store-adapter-php)

