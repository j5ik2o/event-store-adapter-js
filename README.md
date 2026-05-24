# event-store-adapter-js workspace

This repository uses pnpm workspaces.

## Packages

- `packages/library`: published library package (`event-store-adapter-js`)
- `packages/examples`: runnable example package
- `packages/tests`: future test packages, including e2e tests

## Development

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

Library documentation lives in [packages/library/README.md](packages/library/README.md).
