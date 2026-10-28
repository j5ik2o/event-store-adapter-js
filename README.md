# event-store-adapter-js workspace

[![CI](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml?query=branch%3Amain)
[![npm](https://img.shields.io/npm/v/event-store-adapter-js.svg)](https://www.npmjs.com/package/event-store-adapter-js)
[![TypeScript types](https://img.shields.io/npm/types/event-store-adapter-js.svg)](https://www.npmjs.com/package/event-store-adapter-js)
[![Node.js](https://img.shields.io/node/v/event-store-adapter-js.svg)](https://www.npmjs.com/package/event-store-adapter-js)
[![Contract v5](https://img.shields.io/badge/contract-v5-blueviolet.svg)](https://github.com/j5ik2o/event-store-adapter/tree/contract-v5/docs/spec)
[![Storages](https://img.shields.io/badge/storages-memory%20%7C%20DynamoDB%20%7C%20SQLite%20%7C%20Spanner%20%7C%20Bigtable-informational.svg)](https://github.com/j5ik2o/event-store-adapter/tree/main/docs/spec/storage)
[![Renovate](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://renovatebot.com)
[![License](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](https://github.com/j5ik2o/event-store-adapter-js#license)

This repository uses pnpm workspaces.

## Packages

- `packages/library`: published library package (`event-store-adapter-js`)
- `packages/examples`: runnable example package
- `packages/tests`: built and packed package consumption tests

## Development

```shell
pnpm install
pnpm run lint
pnpm run build
pnpm run test
pnpm run coverage
pnpm run example:memory
pnpm run example:dynamodb
pnpm run test:packages
pnpm run test:examples
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, checks and releases.

Library documentation lives in [packages/library/README.md](packages/library/README.md).

The public entry point provides Memory and DynamoDB factories and four envelope-based operations. See the [migration guide](packages/library/docs/MIGRATION_GUIDE.md) for rewriting existing records into the three-table layout.

## License

Dual-licensed under MIT or Apache-2.0 (`MIT OR Apache-2.0`), at your option. See [LICENSE-MIT](LICENSE-MIT) and [LICENSE-APACHE](LICENSE-APACHE).
