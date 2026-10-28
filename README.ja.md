# event-store-adapter-js workspace

[![CI](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/j5ik2o/event-store-adapter-js/actions/workflows/ci.yml?query=branch%3Amain)
[![npm](https://img.shields.io/npm/v/event-store-adapter-js.svg)](https://www.npmjs.com/package/event-store-adapter-js)
[![TypeScript types](https://img.shields.io/npm/types/event-store-adapter-js.svg)](https://www.npmjs.com/package/event-store-adapter-js)
[![Node.js](https://img.shields.io/node/v/event-store-adapter-js.svg)](https://www.npmjs.com/package/event-store-adapter-js)
[![Contract v5](https://img.shields.io/badge/contract-v5-blueviolet.svg)](https://github.com/j5ik2o/event-store-adapter/tree/contract-v5/docs/spec)
[![Storages](https://img.shields.io/badge/storages-memory%20%7C%20DynamoDB%20%7C%20SQLite%20%7C%20Spanner%20%7C%20Bigtable-informational.svg)](https://github.com/j5ik2o/event-store-adapter/tree/main/docs/spec/storage)
[![Renovate](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://renovatebot.com)
[![License](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](https://github.com/j5ik2o/event-store-adapter-js#license)

このリポジトリは pnpm workspace を使います。

## Packages

- `packages/library`: publish 対象の library package (`event-store-adapter-js`)
- `packages/examples`: 実行可能な example package
- `packages/tests`: build・pack成果物の利用試験

## 開発

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

開発の進め方・検査・リリースは [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を参照してください。

ライブラリの README は [packages/library/README.ja.md](packages/library/README.ja.md) を参照してください。

公開入口はMemoryとDynamoDBのfactoryと、封筒を使う4操作を提供します。既存データを新しい3表配置へ書き直す場合は [移行ガイド](packages/library/docs/MIGRATION_GUIDE.ja.md) を参照してください。

## ライセンス

MIT と Apache-2.0 のどちらかを選べる二重ライセンス（`MIT OR Apache-2.0`）です。[LICENSE-MIT](LICENSE-MIT) と [LICENSE-APACHE](LICENSE-APACHE) を参照してください。
