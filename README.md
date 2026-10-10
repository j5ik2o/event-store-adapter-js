# event-store-adapter-js workspace

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

Library documentation lives in [packages/library/README.md](packages/library/README.md).

The public entry point provides Memory and DynamoDB factories and four envelope-based operations. See the [migration guide](packages/library/docs/MIGRATION_GUIDE.md) for rewriting existing records into the three-table layout.
