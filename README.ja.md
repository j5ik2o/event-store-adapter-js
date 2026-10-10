# event-store-adapter-js workspace

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

ライブラリの README は [packages/library/README.ja.md](packages/library/README.ja.md) を参照してください。

公開入口はMemoryとDynamoDBのfactoryと、封筒を使う4操作を提供します。既存データを新しい3表配置へ書き直す場合は [移行ガイド](packages/library/docs/MIGRATION_GUIDE.ja.md) を参照してください。
