## 1. 公開型契約の整理

- [ ] 1.1 `Aggregate`、`AggregateId`、`Event`、`EventStore`、入力契約、シリアライザ、`Logger`、`ShardSelector` を、`interface` 宣言からオブジェクト形状の型エイリアスへ変換する。
- [ ] 1.2 `src/index.ts` と `src/types.ts` からエクスポートされる既存の型名を、廃止対象の `AggregateIdValue` を除いて維持する。
- [ ] 1.3 同名の `EventStore` ランタイムファクトリオブジェクトを維持し、構築メソッドを `EventStore.createDynamoDB(...)`、`EventStore.createMemory(...)`、`EventStore.createSpanner(...)` へ改名する。
- [ ] 1.4 `createShardId(...)`、`createShardCount(...)` を `ShardId.create(...)`、`ShardCount.create(...)` へ置き換える。
- [ ] 1.5 `AggregateIdValue` と `createAggregateIdValue(...)` を互換用置き換えなしで削除し、`AggregateId.value` を plain `string` にして、集約 ID の検証と具象生成をユーザー側コードの AID ファクトリへ移す。
- [ ] 1.6 旧ファクトリ名を互換用置き換えなしで削除する。
- [ ] 1.7 プレーンオブジェクト値が `class` 宣言なしで `Aggregate`、`AggregateId`、`Event`、`EventStore` を満たすことを確認する型レベルテストを追加または更新する。

## 2. Result と判別共用体によるエラー契約への移行

- [ ] 2.1 `Result<T, E>` を型エイリアスで定義し、`Result.ok(...)` / `Result.err(...)` の同名ファクトリオブジェクトを公開する。
- [ ] 2.2 楽観ロック失敗、設定不備、シリアライズ失敗、ストレージ失敗など、呼び出し側が判断すべき回復可能な失敗を `EventStoreError` の判別共用体として定義し、`EventStoreError.*(...)` の同名ファクトリオブジェクトを公開する。
- [ ] 2.3 `OptimisticLockError` の公開 `Error` サブクラスと例外送出を削除し、楽観ロック失敗を `EventStoreError` の `type` で識別できるようにする。
- [ ] 2.4 EventStore の公開非同期操作を、契約上想定される失敗について `throw` ではなく `Promise<Result<..., EventStoreError>>` で返す形に更新する。
- [ ] 2.5 呼び出し側サンプルとテストを、`try/catch` と `instanceof OptimisticLockError` ではなく `result.type` / `result.error.type` による分岐へ移行する。

## 3. クラスを使わないランタイム実装への移行

- [ ] 3.1 内部 EventStore 実装クラスをファクトリ関数またはクロージャで支えるオブジェクトへ置き換える。
- [ ] 3.2 集約キー、デフォルトシリアライザ、シャードセレクタ、非公開エラークラス、テスト用代替実装などの内部補助クラスを、型エイリアス、オブジェクトファクトリ、または関数へ置き換える。
- [ ] 3.3 テストが実装クラスを直接構築しなくてよいよう、内部構築を `EventStore.createX(...)` または内部ファクトリ補助関数経由にする。
- [ ] 3.4 公開 API オブジェクトは凍結するか、サポート対象の呼び出し方では変更できない形にする。
- [ ] 3.5 アダプタ内の可変状態はクロージャ内に隔離し、呼び出し側から渡された可変の初期データは防御的コピーを行う。

## 4. サンプルとドキュメントの更新

- [ ] 4.1 サンプルの集約 ID、イベント、集約モデルを、型エイリアス、同名ファクトリオブジェクト、不変オブジェクト値として書き換える。
- [ ] 4.2 サンプルとライブラリ内テスト用データの `instanceof` によるイベント分岐を、`typeName` のような安定したイベントデータに基づく判別処理へ置き換える。
- [ ] 4.3 README のサンプルを更新し、ライブラリが構造的な値だけを要求する箇所では `class` ではなく不変オブジェクト値と同名ファクトリオブジェクトを示す。
- [ ] 4.4 `try/catch` と `instanceof OptimisticLockError` のサンプルを、`Result` と `EventStoreError.type` による分岐へ置き換える。
- [ ] 4.5 `interface` 宣言マージが互換契約の対象外になる意図的な破壊的変更を文書化する。
- [ ] 4.6 旧ファクトリ名から `create` メソッドへの意図的な破壊的変更を文書化する。
- [ ] 4.7 既存の `packages/library/docs/MIGRATION_GUIDE_3.0.md` / `MIGRATION_GUIDE_3.0.ja.md` とは別に、4.0.0 向けの移行ガイドを英日で追加し、旧ファクトリ名、`interface` 宣言マージ、クラスベースのサンプル、例外ベースの楽観ロック処理からの移行手順を明記する。
- [ ] 4.8 互換用置き換えを提供しない公開 API 破壊を含むため、リリース計画では 3.x 維持ではなく 4.0.0 として扱うことを明記する。

## 5. 検証

- [ ] 5.1 ライブラリとサンプルのフォーマッタ / lint を実行する。
- [ ] 5.2 ライブラリのビルドを実行し、生成された宣言ファイルがエクスポート名を維持していることを確認する。
- [ ] 5.3 EventStore 契約テストを含む関連 Jest テスト群を実行する。
- [ ] 5.4 生成された `dist/*.d.ts` を確認し、ランタイム export の意図しない削除や型 export の欠落がないことを確認する。
- [ ] 5.5 Spanner adapter の未回復 `ABORTED` を楽観ロック失敗ではなくストレージ失敗の `EventStoreError` として返す Jest テストを追加または更新する。
- [ ] 5.6 `sh -c 'rg "createShardId|createShardCount|createAggregateIdValue|AggregateIdValue|ofMemory|ofDynamoDB|ofSpanner" packages/library/src packages/examples/src; test $? -eq 1'` で、コード / export 面に旧ファクトリ名とライブラリ所有の集約 ID 値型が残っていないことを確認する。
- [ ] 5.7 `sh -c 'rg "instanceof" packages/library/src/internal/test packages/examples/src/domain; test $? -eq 1'` で、サンプルとライブラリ内テスト用データのイベント分岐に `instanceof` が残っていないことを確認する。
- [ ] 5.8 `sh -c 'rg "OptimisticLockError" packages/library/src packages/examples/src; test $? -eq 1'` で、旧公開エラークラス名と `instanceof OptimisticLockError` 分岐がコード / export 面に残っていないことを確認する。
- [ ] 5.9 `sh -c 'rg "(^|[[:space:]])class[[:space:]]+|extends Error" packages/library/src packages/examples/src; test $? -eq 1'` で、テストファイルを含むライブラリ src とサンプルに、本ライブラリ定義クラスとエラーサブクラスが残っていないことを確認する。
- [ ] 5.10 `Result.ok(...)` / `Result.err(...)` と `EventStoreError.*(...)` がランタイム API として export され、生成された宣言ファイルにも含まれることを確認する。
- [ ] 5.11 公開 API オブジェクトと値ファクトリオブジェクトが、サポート対象の使い方では外部からメソッド表を変更できないことをテストで確認する。
- [ ] 5.12 4.0.0 向け移行ガイドに、`EventStore.ofX(...)` から `EventStore.createX(...)`、`createShardId(...)` から `ShardId.create(...)`、ライブラリ提供の `AggregateIdValue` / `createAggregateIdValue(...)` から plain `string` を保持するユーザー側 `UserAccountId.create(...)`、`try/catch` から `Result` 分岐への before / after が含まれていることを確認する。
- [ ] 5.13 `replace-interfaces-with-types` の OpenSpec 状態確認を実行し、change が適用可能なままであることを確認する。
