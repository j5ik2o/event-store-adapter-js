const assert = require("node:assert/strict");
const test = require("node:test");
const { EventStore } = require("event-store-adapter-js");

test("tests package can consume the built workspace library", () => {
  const eventStore = EventStore.createMemory();

  assert.equal(typeof eventStore.persistEvent, "function");
  assert.equal(typeof eventStore.getEventsByIdSinceSequenceNumber, "function");
  assert.equal(typeof eventStore.getLatestSnapshotById, "function");
});
