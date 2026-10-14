# API surface（公開 API の形）の照合

共通契約 v5 が公開 API に求める「形」を、`packages/library/src/index.ts` が満たすかを照合する。

- `surface.json`: ハブ（j5ik2o/event-store-adapter の `api-surface/surface.json`、形式 0.1.0）の写し。CI の `release-checks` が `sha256sum -c` で SHA-256 を照合する。
- `js.json`: 共通の名前と js の公開 API の対応表（型の引数、値の種類、型・要素・構築関数、ストアの操作、エラー分類の `type` の値）。

## 照合のしかた

```sh
cd packages/library
pnpm test -- src/internal/test/api-surface
```

`packages/library/src/internal/test/api-surface/` の試験が TypeScript のコンパイラ API で `index.ts` を型検査し、`surface.json` と `js.json` から期待する形を導いて照合する。ずれは「どの型・要素・操作が、どう違うか」を 1 件ずつ報告する。形をわざとずらした定義（`fixtures/`）を使う否定の試験 7 件が、照合がそれぞれのずれだけを報告することを確かめる。

## 確かめていること

- 3 つの型（イベント封筒、スナップショット封筒、スナップショット読み取り結果）と各要素があり、要素の型が値の種類と合うこと
- 型の引数の名前が対応表どおりで、`extends` による制約がないこと
- 構築関数（`create`）の入力で、`required: true` の要素が必須、`required: false` の要素が省略可能であること
- ストアの 4 つの操作の入力と出力（`Promise<Result<T, EventStoreError>>` で包んだ形）
- エラーの 5 つの分類の `type` の値が `EventStoreError` に揃っていること

## 確かめられないこと

- 振る舞い（楽観ロック、採番、保持期間など）。これは `conformance/` の適合テストデータで確かめる
- メモリ・DynamoDB の実装（公開の型と操作だけが対象）
- 形が定めていない要素や操作が存在しないこと
