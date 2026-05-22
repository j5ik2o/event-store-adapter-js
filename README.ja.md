# event-store-adapter-js workspace

このリポジトリは pnpm workspace を使います。

## Packages

- `packages/library`: publish 対象の library package (`event-store-adapter-js`)
- `packages/examples`: 今後の example package 置き場
- `packages/tests`: e2e を含む今後の test package 置き場

## 開発

```shell
$ pnpm install
$ pnpm run lint
$ pnpm run build
$ pnpm run test
$ pnpm run coverage
```

ライブラリの README は [packages/library/README.ja.md](packages/library/README.ja.md) を参照してください。
