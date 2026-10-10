# event-store-adapter-js examples

新しい公開入口からMemoryとDynamoDBの4操作を実行します。payloadにはbrandとメソッドを持つドメイン値を使い、serializerで復元します。封筒のaggregateId・seqNr・occurredAt・manifestはpayloadから分離しています。

rootから実行します。

```shell
pnpm run example:memory
pnpm run example:dynamodb
pnpm run test:examples
```

MemoryはDocker不要です。DynamoDBはTestcontainersからDynamoDB Local 3.3.1を起動し、3表と履歴GSIを作成するため、Dockerが必要です。

`src/domain/user-account-repository.ts` は両保存先の共通リポジトリです。snapshot番号＋1、snapshotなしなら1から読み、Resultを処理します。`src/domain/user-account-serializers.ts` がdomain値のbrandとメソッドを復元します。実例ではsnapshot付き作成、event-only更新、snapshotあり・なしの復元、重複書き込みの楽観ロック検出を確認します。復元開始番号と元causeの保持は `src/domain/user-account.test.ts` でも検査します。
