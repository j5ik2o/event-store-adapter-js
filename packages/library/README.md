# event-store-adapter-js

[![CI](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/event-store-adapter-js.svg)](https://badge.fury.io/js/event-store-adapter-js)
[![Renovate](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://renovatebot.com)
[![License](https://img.shields.io/badge/License-APACHE2.0-blue.svg)](https://opensource.org/licenses/apache-2-0)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![](https://tokei.rs/b1/github/j5ik2o/event-store-adapter-js)](https://github.com/XAMPPRocky/tokei)

This library is designed to turn DynamoDB into an Event Store for CQRS/Event Sourcing.

[日本語](./README.ja.md)

# Installation

```shell
npm install event-store-adapter-js
```

# Usage

You can easily implement an Event Sourcing-enabled repository using EventStore.

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

The following is an example of the repository usage.

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
// if you want to use Cloud Spanner, pass a caller-managed Database.
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

## Runtime brands and JSON conversion

The sample domain values use module-private `unique symbol` brands to tell
factory-created values apart from plain objects inside the current process.
`typeName` remains the JSON boundary discriminant; the symbol brand is not
serialized and must be restored by a factory.

```typescript
const USER_ACCOUNT_ID_BRAND: unique symbol = Symbol("UserAccountId");

type UserAccountId = AggregateId & {
    typeName: "user-account";
    readonly [USER_ACCOUNT_ID_BRAND]: true;
};

namespace UserAccountId {
    export function create(value: string): UserAccountId {
        return Object.freeze({
            [USER_ACCOUNT_ID_BRAND]: true,
            typeName: "user-account",
            value,
            asString: () => `user-account-${value}`,
        });
    }

    export function is(value: unknown): value is UserAccountId {
        return (
            typeof value === "object" &&
            value !== null &&
            (value as Partial<UserAccountId>)[USER_ACCOUNT_ID_BRAND] === true
        );
    }

    export function toJSON(value: UserAccountId) {
        return { typeName: value.typeName, value: value.value };
    }

    export function fromJSON(json: { typeName: "user-account"; value: string }) {
        return create(json.value);
    }
}
```

`JSON.stringify(...)` drops the symbol brand. In EventStore converters, call the
domain `fromJSON(...)` function so deserialized events and snapshots become
branded values again. The `EventSerializer` and `SnapshotSerializer` APIs stay
unchanged; their `deserialize(bytes, converter)` contract still delegates
domain reconstruction to the converter.

## Development

This repository uses pnpm workspaces. The library package is located at
`packages/library`. Runnable examples are located at `packages/examples`, and
`packages/tests` is reserved for future e2e test packages.

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

## Table Specifications

See [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md).

For Cloud Spanner, see [docs/SPANNER_DATABASE_SCHEMA.md](docs/SPANNER_DATABASE_SCHEMA.md).

## CQRS/Event Sourcing Example

See [j5ik2o/cqrs-es-example-js](https://github.com/j5ik2o/cqrs-es-example-js).

## License

Dual-licensed under MIT and Apache-2.0.
See [LICENSE-MIT](LICENSE-MIT) and [LICENSE-APACHE](LICENSE-APACHE).

## Links

- [Common Documents](https://github.com/j5ik2o/event-store-adapter)
