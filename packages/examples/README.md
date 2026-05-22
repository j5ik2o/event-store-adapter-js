# event-store-adapter-js examples

`packages/examples` には、ユーザ開発者が Event Sourcing 対応リポジトリの実装を学ぶための実行可能なサンプルがあります。

## サンプル

| コマンド | 内容 | Docker |
| --- | --- | --- |
| `npm run example:memory` | インメモリの EventStore で基本の作成、更新、再構築、楽観ロック検出を確認します。 | 不要 |
| `npm run example:dynamodb` | LocalStack の DynamoDB コンテナを起動し、DynamoDB backend で同じ流れを確認します。 | 必要 |
| `npm run example:spanner` | Cloud Spanner emulator コンテナを起動し、Spanner backend で同じ流れを確認します。 | 必要 |

すべて repo root から実行できます。

```shell
npm run example:memory
npm run example:dynamodb
npm run example:spanner
```

DynamoDB と Spanner のサンプルは `testcontainers` を使います。Docker が起動している必要があります。Spanner emulator は初回実行時の image pull に時間がかかることがあります。

## 読み方

`src/domain` にはサンプル用の `UserAccount` 集約、イベント、リポジトリがあります。各 backend の違いは `src/memory-basic.ts`、`src/dynamodb-basic.ts`、`src/spanner-basic.ts` の EventStore 作成部分に閉じています。
