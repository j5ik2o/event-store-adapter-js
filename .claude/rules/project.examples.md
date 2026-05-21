# Project Rules - Examples

## Project-specific Examples

### ワークスペース構成
```text
modules/
├── utils-core/         # no_std 共通プリミティブ（ArcShared / Shared* / SpinSync* / time / net）
├── utils-adaptor-std/  # std 環境向けアダプタ
├── actor-core/         # ActorSystem / mailbox / supervision / typed
├── actor-adaptor-std/  # Tokio executor 等の std 実装
├── persistence-core/   # Event sourcing / journal / snapshot
├── remote-core/        # remoting / endpoint / failure detection
├── remote-adaptor-std/
├── cluster-core/       # membership / placement / pub-sub
├── cluster-adaptor-std/
├── stream-core/        # reactive stream
└── stream-adaptor-std/
showcases/std/          # 実行可能サンプル（modules/**/examples は禁止）
tests/e2e/              # cross-crate E2E
references/             # protoactor-go (Go) / pekko (Scala)
```

### `*-core` クレートの lib.rs ヘッダ
```rust
// modules/actor-core/src/lib.rs（抜粋）
#![deny(missing_docs)]
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::missing_errors_doc)]
#![deny(clippy::missing_panics_doc)]
#![cfg_attr(not(test), deny(clippy::unwrap_used))]
#![cfg_attr(not(test), deny(clippy::expect_used))]
#![allow(unknown_lints)]
#![deny(cfg_std_forbid)]
#![cfg_attr(not(test), no_std)]

extern crate alloc;
```

### `clippy.toml` による型置換の強制
```toml
# modules/actor-core/clippy.toml
disallowed-types = [
  { path = "alloc::sync::Arc",  reason = "Use ArcShared", replacement = "fraktor_utils_core_rs::core::sync::ArcShared" },
  { path = "std::sync::Arc",    reason = "Use ArcShared", replacement = "fraktor_utils_core_rs::core::sync::ArcShared" },
  { path = "std::sync::Mutex",  reason = "Use SpinSyncMutex", replacement = "fraktor_utils_core_rs::core::sync::SpinSyncMutex" },
  { path = "spin::Mutex",       reason = "Use SpinSyncMutex", replacement = "fraktor_utils_core_rs::core::sync::SpinSyncMutex" },
  { path = "spin::Once",        reason = "Use SyncOnce",      replacement = "fraktor_utils_core_rs::core::sync::SyncOnce" },
]
```

### `./scripts/ci-check.sh`

実行範囲、TAKT 例外、並行実行禁止は `./project.md` の `CI / Verification` を正とする。

### 中間アーティファクト配置
```text
.takt/               # takt 実行時の中間生成物（レポート・分析・決定ログ）
docs/plan/           # 人間 / AI が書く investigation / plan / design notes
docs/gap-analysis/   # 参照実装とのギャップ分析
```
プロジェクトルート直下や `reports/` のような新規ディレクトリに中間生成物を作らない。

### 参照実装の読み方
```text
references/protoactor-go/      # Go 実装 → goroutine + channel ベース
references/pekko/              # Scala 実装 → trait 階層 + implicit ベース
```
設計開始時に対応概念を特定 → 公開型数を比較（fraktor-rs ≤ 参照実装 × 1.5 が目安）→ Rust イディオムに変換 → no_std 制約適用 → YAGNI で最小 API を保つ、の順で逆輸入する。
