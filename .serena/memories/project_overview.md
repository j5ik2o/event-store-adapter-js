# event-store-adapter-js overview
- Purpose: TypeScript library that uses DynamoDB as an event store for CQRS/Event Sourcing, with an in-memory implementation for tests/examples.
- Public API is small: `EventStore`, `EventStoreFactory`, and domain contracts in `src/types.ts`.
- Main implementations: `src/internal/event-store-for-dynamodb.ts` and `src/internal/event-store-for-memory.ts`.
- DynamoDB design uses two tables: journal and snapshot. Replay reads latest snapshot then replays journal events since snapshot sequence.
- OpenSpec is configured with `schema: spec-driven`, but `openspec list --json` currently reports no active changes.
- Docs of note: `README.md`, `docs/DATABASE_SCHEMA.md`, `docs/GCP_EVENT_INTEGRATION.ja.md`.