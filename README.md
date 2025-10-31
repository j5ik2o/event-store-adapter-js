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
$ npm install event-store-adapter-js
```

# Usage

You can easily implement an Event Sourcing-enabled repository using EventStore.

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
            convertJSONToUserAccount,
        );
        if (snapshot === undefined) {
            return undefined;
        } else {
            const events = await this.eventStore.getEventsByIdSinceSequenceNumber(
                id,
                snapshot.sequenceNumber + 1,
                convertJSONtoUserAccountEvent,
            );
            return UserAccount.replay(events, snapshot);
        }
    }
}
```

The following is an example of the repository usage.

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

## Table Specifications

See [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md).

## CQRS/Event Sourcing Example

See [j5ik2o/cqrs-es-example-js](https://github.com/j5ik2o/cqrs-es-example-js).

## License.

MIT License. See [LICENSE](LICENSE) for details.

## Links

- [Common Documents](https://github.com/j5ik2o/event-store-adapter)

