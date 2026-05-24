## 1. 公開型契約の整理

- [ ] 1.1 `Aggregate`、`AggregateId`、`Event`、`EventStore`、入力契約、シリアライザ、`Logger`、`ShardSelector` を、`interface` 宣言からオブジェクト形状の型エイリアスへ変換する。
- [ ] 1.2 `src/index.ts` と `src/types.ts` からエクスポートされる既存の型名を維持する。
- [ ] 1.3 同名の `EventStore` ランタイムファクトリオブジェクトを維持し、構築メソッドを `EventStore.createDynamoDB(...)`、`EventStore.createMemory(...)`、`EventStore.createSpanner(...)` へ改名する。
- [ ] 1.4 `createAggregateIdValue(...)`、`createShardId(...)`、`createShardCount(...)` を `AggregateIdValue.create(...)`、`ShardId.create(...)`、`ShardCount.create(...)` へ置き換える。
- [ ] 1.5 旧ファクトリ名を互換用置き換えなしで削除する。
- [ ] 1.6 プレーンオブジェクト値が `class` 宣言なしで `Aggregate`、`AggregateId`、`Event`、`EventStore` を満たすことを確認する型レベルテストを追加または更新する。

## 2. クラスを使わないランタイム実装への移行

- [ ] 2.1 内部 EventStore 実装クラスをファクトリ関数またはクロージャで支えるオブジェクトへ置き換える。
- [ ] 2.2 集約キー、デフォルトシリアライザ、シャードセレクタ、非公開エラークラス、テスト用代替実装などの内部補助クラスを、型エイリアス、オブジェクトファクトリ、または関数へ置き換える。
- [ ] 2.3 `OptimisticLockError` は公開 `Error` サブクラスとして残し、`instanceof OptimisticLockError` の挙動を維持する。
- [ ] 2.4 テストが実装クラスを直接構築しなくてよいよう、内部構築を `EventStore.createX(...)` または内部ファクトリ補助関数経由にする。
- [ ] 2.5 公開 API オブジェクトは凍結するか、サポート対象の呼び出し方では変更できない形にする。
- [ ] 2.6 アダプタ内の可変状態はクロージャ内に隔離し、呼び出し側から渡された可変の初期データは防御的コピーを行う。

## 3. サンプルとドキュメントの更新

- [ ] 3.1 サンプルの集約 ID、イベント、集約モデルを、型エイリアス、同名ファクトリオブジェクト、不変オブジェクト値として書き換える。
- [ ] 3.2 サンプルとライブラリ内テスト用データの `instanceof` によるイベント分岐を、`typeName` のような安定したイベントデータに基づく判別処理へ置き換える。
- [ ] 3.3 README のサンプルを更新し、ライブラリが構造的な値だけを要求する箇所では `class` ではなく不変オブジェクト値と同名ファクトリオブジェクトを示す。
- [ ] 3.4 `interface` 宣言マージが互換契約の対象外になる意図的な破壊的変更を文書化する。
- [ ] 3.5 旧ファクトリ名から `create` メソッドへの意図的な破壊的変更を文書化する。
- [ ] 3.6 既存の `packages/library/docs/MIGRATION_GUIDE_3.0.md` / `MIGRATION_GUIDE_3.0.ja.md` とは別に、4.0.0 向けの移行ガイドを英日で追加し、旧ファクトリ名、`interface` 宣言マージ、クラスベースのサンプルからの移行手順を明記する。
- [ ] 3.7 互換用置き換えを提供しない公開 API 破壊を含むため、リリース計画では 3.x 維持ではなく 4.0.0 として扱うことを明記する。

## 4. 検証

- [ ] 4.1 ライブラリとサンプルのフォーマッタ / lint を実行する。
- [ ] 4.2 ライブラリのビルドを実行し、生成された宣言ファイルがエクスポート名を維持していることを確認する。
- [ ] 4.3 EventStore 契約テストを含む関連 Jest テスト群を実行する。
- [ ] 4.4 生成された `dist/*.d.ts` を確認し、ランタイム export の意図しない削除や型 export の欠落がないことを確認する。
- [ ] 4.5 `rg "createShardId|createShardCount|createAggregateIdValue|ofMemory|ofDynamoDB|ofSpanner" packages/library/src packages/examples/src` で、コード / export 面に旧ファクトリ名が残っていないことを確認する。
- [ ] 4.6 `rg "instanceof (UserAccount|.*Event)" packages/library/src/internal/test packages/examples/src/domain` で、サンプルとライブラリ内テスト用データのイベント分岐に `instanceof` が残っていないことを確認する。
- [ ] 4.7 `OptimisticLockError` と外部 SDK 利用を除き、本ライブラリ定義 `class` が残っていないことを確認する。
- [ ] 4.8 4.0.0 向け移行ガイドに、`EventStore.ofX(...)` から `EventStore.createX(...)`、`createShardId(...)` から `ShardId.create(...)` などの before / after が含まれていることを確認する。
- [ ] 4.9 `replace-interfaces-with-types` の OpenSpec 状態確認を実行し、change が適用可能なままであることを確認する。
