# Project Rules: fraktor-rs

## Architecture

- **概要**: Specification-driven actor runtime。Apache Pekko / Proto.Actor のセマンティクスを `no_std` と `std` の両環境にもたらす Rust ランタイム
- **ワークスペース**: `modules/{utils,actor,persistence,remote,cluster,stream}-{core,adaptor-std}` の 6 ドメイン × 2 層構成 + `showcases/std`（実行可能サンプル）+ `tests/e2e`
- **`*-core` クレート**: `#![cfg_attr(not(test), no_std)]` + `#![deny(cfg_std_forbid)]` で std 直接依存を禁止。`extern crate alloc` で `alloc` を取り込む。`utils-core` / `actor-core` / `persistence-core` / `remote-core` / `cluster-core` / `stream-core` の 6 本
- **`*-adaptor-std` クレート**: std 環境固有のアダプタ実装（Tokio executor、std::time、std::net 等）を集約。`*-core` の trait をホストランタイム向けに具象化
- **参照実装**: `references/protoactor-go/`（Go）、`references/pekko/`（Scala）。新機能設計開始時 / 命名で迷ったとき / 過剰設計が疑われるときに必ず参照する
- **集約 crate**: ルートの `fraktor-rs` は `modules/*` を再エクスポートする publish 用ファサード（`Cargo.toml` の `[package]` に `fraktor-rs` 自身が定義されている）

## Toolchain & Build

- **Rust toolchain**: `nightly-2025-12-01`（`rust-toolchain.toml` で固定）。lint 自身が `rustc_private` を要求するため nightly 必須
- **Edition**: `2024`（workspace 全体で統一）
- **`.cargo/config.toml`**: `--cfg portable_atomic_unstable_coerce_unsized` を有効化
- **clippy.toml（disallowed-types）**: `Arc` / `Rc` / `std::sync::Mutex` / `spin::Mutex` / `spin::RwLock` / `spin::Once` の直接使用を禁止し `ArcShared` / `SpinSyncMutex` / `SpinSyncRwLock` / `SyncOnce` への置換を強制
- **workspace lints**: `unused_must_use = "deny"`、`clippy::let_underscore_must_use = "deny"`、`clippy::let_underscore_future = "deny"`
- **Custom dylint**: `lints/` 配下に 11 本実装、`workspace.metadata.dylint.libraries` で 10 本を有効化（`mod-file` / `module-examples` / `module-wiring` / `type-per-file` / `tests-location` / `use-placement` / `redundant-fqcn` / `rustdoc` / `cfg-std-forbid` / `ambiguous-suffix`）。`let-underscore-forbid-lint` は実装済みだが workspace 未登録
- **OpenSpec commands**: OpenSpec は必ず `mise exec -- openspec ...` で実行する。裸の `openspec` shim や `scripts/opsx-cli.sh` に依存しない。AI エージェントの非対話 shell では mise hook / shim / PATH が人間の terminal と同じとは限らないため、`mise.toml` の設定を明示的に通す

## CI / Verification

- **最終確認コマンド**: `./scripts/ci-check.sh ai all`（AI 向けガード付き、所要時間長め）
- **TAKT 例外**: TAKT ピース実行中は `final-ci` ムーブメント以外で `./scripts/ci-check.sh ai all` を実行しない（各ムーブメントの指示に従う）
- **途中工程**: 対象範囲のテストに留める（`unit-test` / `integration-test` / `dylint <name>` / `clippy` / `no-std` / `examples` / `embedded` / `e2e-test` 等）
- **並行実行不可**: `./scripts/ci-check.sh` は内部で `cargo` を呼ぶ。複数同時起動は競合する
- **環境変数**: `CI_CHECK_GUARD_TIMEOUT_SEC` / `CI_CHECK_GUARD_KILL_AFTER_SEC` / `CI_CHECK_HANG_COOLDOWN_SEC` で hang 防止のガードを調整できる

## Conventions

- **コミュニケーション言語**: 日本語（rustdoc は英語、Markdown / インラインコメントは日本語）
- **後方互換性**: 不要（pre-release。破壊的変更を恐れずに最適な設計を優先）
- **ボーイスカウトルール**: 適用するが、優先順位・依存関係を考慮した上で
- **TOCTOU 回避**: read-then-act を `with_write` クロージャ等で原子化し、ガードを外部に返さない設計を優先
- **CHANGELOG.md**: GitHub Actions が自動生成する。AI エージェントは編集しない
- **lint への `#[allow]`**: 安易に付けない。付ける場合は人間から許可を取る
- **設計・命名・構造ルール変更**: `.agents/rules/` 配下の rule 変更は人間許可が必要

## Intermediate Artifacts

- **takt 中間アーティファクト** → `.takt/` 配下（プロジェクトルート直下や `reports/` 等のソースツリーに作らない）
- **計画ドキュメント (investigation / plan / design notes)** → `docs/plan/` 配下（`.takt/` には置かない）
- **ギャップ分析等のレポート** → `docs/gap-analysis/` 配下

## Out-of-scope Directories

以下は別エージェント / 別ツールの設定領域。当該タスクに直接関係しない場合は読まない:

- `.codex/`、`.codex-corporate/`、`.codex-personal/` - OpenAI Codex CLI 設定
- `.cursor/`、`.gemini/`、`.opencode/` - 各種 AI エディタ設定
- `references/` - 参照実装（Pekko / protoactor-go）。設計参照時のみ読む
- `.git/`、`.idea/` - VCS / IDE メタデータ

## Examples

迷ったら `./project.examples.md` を見る。
