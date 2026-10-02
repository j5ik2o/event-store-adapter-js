# DDD モジュール配置ポリシー

モジュールをファイルにどう置くかを、Rust と TypeScript について定める。配置は `.ddd.toml` で言語ごとに 1 つ選び、すべてのパッケージ、層、テスト、example、ビルドスクリプトに適用する。既存のファイルは配置の根拠にならず、既存のスタイルに合わせることが設定より優先されることはない。

## 共通

| 基準 | 判定 |
|------|------|
| コードを生成する前に、`.ddd.toml` で配置を選んでいない | REJECT。先に 1 つ選ぶ |
| 1 つのモジュールに両方の置き方がある（`invoice.rs` と `invoice/mod.rs`、`src/invoice.ts` と `src/invoice/index.ts`） | REJECT |
| パッケージのルートから到達できないファイルがある、または子が移動した後に古い `mod.rs` や `index.ts` が残っている | REJECT |

## Rust

| 基準 | 判定 |
|------|------|
| `file` 配置で、子を持つモジュールが `<m>/mod.rs` になっている | REJECT。`<m>/` の隣に `<m>.rs` を置く |
| `mod-rs` 配置で、子を持つモジュールが `<m>.rs` になっている | REJECT。`<m>/mod.rs` を使う。葉は `<leaf>.rs` のまま |
| 選んだ配置から逃れるために `#[path]` 属性を使っている | REJECT |

## TypeScript

| 基準 | 判定 |
|------|------|
| `named-file` 配置で、子を持つモジュールが `src/<m>/index.ts` になっている | REJECT。`src/<m>/` の隣に `src/<m>.ts` を置く |
| `index-file` 配置で、子を持つモジュールが `src/<m>.ts` になっている | REJECT。`src/<m>/index.ts` を使う。葉は `<leaf>.ts` のまま |
| モジュールのファイル名が `<module>.ts` ではない（`invoice.model.ts`） | REJECT |
| テスト、宣言ファイル、`.tsx`・`.mts`・`.cts` のソースをパッケージの `src` の中に置いている | REJECT。`src` の外に置く |
