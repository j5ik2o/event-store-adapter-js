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

void [
  EventStore,
  BigtableEventStore,
  SpannerEventStore,
  SqliteEventStore,
  sameStores,
];
