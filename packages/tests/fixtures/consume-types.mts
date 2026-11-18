import { EventStore } from "event-store-adapter-js";
import { BigtableEventStore } from "event-store-adapter-js/bigtable";
import { SpannerEventStore } from "event-store-adapter-js/spanner";
import { SqliteEventStore } from "event-store-adapter-js/sqlite";

// @ts-expect-error The native ESM entry point has no default export.
import rootDefault from "event-store-adapter-js";
// @ts-expect-error The native ESM entry point has no default export.
import bigtableDefault from "event-store-adapter-js/bigtable";
// @ts-expect-error The native ESM entry point has no default export.
import spannerDefault from "event-store-adapter-js/spanner";
// @ts-expect-error The native ESM entry point has no default export.
import sqliteDefault from "event-store-adapter-js/sqlite";

void [
  EventStore,
  BigtableEventStore,
  SpannerEventStore,
  SqliteEventStore,
  rootDefault,
  bigtableDefault,
  spannerDefault,
  sqliteDefault,
];
