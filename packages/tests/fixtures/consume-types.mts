import { EventStore } from "event-store-adapter-js";
import { BigtableEventStore } from "event-store-adapter-js/bigtable";
import { SpannerEventStore } from "event-store-adapter-js/spanner";
import { SqliteEventStore } from "event-store-adapter-js/sqlite";

import rootDefault from "event-store-adapter-js";
import bigtableDefault from "event-store-adapter-js/bigtable";
import spannerDefault from "event-store-adapter-js/spanner";
import sqliteDefault from "event-store-adapter-js/sqlite";

// 5.2.0 typed the default import as the CommonJS module's exports.
const sameStores: [
  typeof EventStore,
  typeof BigtableEventStore,
  typeof SpannerEventStore,
  typeof SqliteEventStore,
] = [
  rootDefault.EventStore,
  bigtableDefault.BigtableEventStore,
  spannerDefault.SpannerEventStore,
  sqliteDefault.SqliteEventStore,
];

// 5.2.0 also resolved types, including type-only exports, through the default.
type DefaultTypes = [
  rootDefault.AggregateId,
  rootDefault.Result<number, rootDefault.EventStoreError>,
  rootDefault.EventStore<unknown, unknown>,
  rootDefault.Logger,
  spannerDefault.SpannerEventStoreInput<unknown, unknown>,
  sqliteDefault.SqliteEventStoreInput<unknown, unknown>,
  bigtableDefault.BigtableEventStoreInput<unknown, unknown>,
];
export type { DefaultTypes };

void [
  EventStore,
  BigtableEventStore,
  SpannerEventStore,
  SqliteEventStore,
  sameStores,
];
