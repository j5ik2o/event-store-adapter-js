# Bundled native extractor

`bin/<platform-key>/ddd-rust-syn-spike` is the Rust declaration extractor every Rust
check decides on. It is built from the Rust crate in `rust-extractor/` by
`bun build-extractor.ts` and shipped as a release build, so a check needs neither
`cargo` nor `rustc` on a platform it ships for.

The executable links the third-party crates below. They are the crate's normal
dependency graph as `cargo tree -e normal` resolves it from the committed
`rust-extractor/Cargo.lock`, and the license expressions are the ones
`cargo metadata` reports for those versions.

| Crate | Version | License | Source |
|---|---|---|---|
| `block-buffer` | 0.10.4 | MIT OR Apache-2.0 | https://crates.io/crates/block-buffer |
| `cfg-if` | 1.0.4 | MIT OR Apache-2.0 | https://crates.io/crates/cfg-if |
| `cpufeatures` | 0.2.17 | MIT OR Apache-2.0 | https://crates.io/crates/cpufeatures |
| `crypto-common` | 0.1.7 | MIT OR Apache-2.0 | https://crates.io/crates/crypto-common |
| `digest` | 0.10.7 | MIT OR Apache-2.0 | https://crates.io/crates/digest |
| `generic-array` | 0.14.7 | MIT | https://crates.io/crates/generic-array |
| `itoa` | 1.0.18 | MIT OR Apache-2.0 | https://crates.io/crates/itoa |
| `libc` | 0.2.189 | MIT OR Apache-2.0 | https://crates.io/crates/libc |
| `memchr` | 2.8.3 | Unlicense OR MIT | https://crates.io/crates/memchr |
| `proc-macro2` | 1.0.107 | MIT OR Apache-2.0 | https://crates.io/crates/proc-macro2 |
| `quote` | 1.0.47 | MIT OR Apache-2.0 | https://crates.io/crates/quote |
| `serde` | 1.0.229 | MIT OR Apache-2.0 | https://crates.io/crates/serde |
| `serde_core` | 1.0.229 | MIT OR Apache-2.0 | https://crates.io/crates/serde_core |
| `serde_json` | 1.0.151 | MIT OR Apache-2.0 | https://crates.io/crates/serde_json |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 | https://crates.io/crates/sha2 |
| `syn` | 3.0.5 | MIT OR Apache-2.0 | https://crates.io/crates/syn |
| `typenum` | 1.20.1 | MIT OR Apache-2.0 | https://crates.io/crates/typenum |
| `unicode-ident` | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 | https://crates.io/crates/unicode-ident |
| `zmij` | 1.0.23 | MIT | https://crates.io/crates/zmij |

`unicode-ident` embeds tables derived from the Unicode Character Database, which is
why its expression adds `Unicode-3.0` to the dual license the rest of the list uses.

Two crates `Cargo.lock` resolves are not listed, because neither is linked into the
executable: `serde_derive` is a procedural macro that runs only while the crate is
compiled, and `version_check` is a build-script dependency of `generic-array`.

The list is resolved for the platform the recorded build targets (`darwin-arm64`).
Target-specific dependencies such as `libc` follow the target, so a build for another
platform key must re-run the commands below and update this list.

## Reproducing this list

```sh
cd rust-extractor
cargo tree --offline -e normal --prefix none --format '{p} {l}' | sort -u
cargo metadata --offline --format-version 1
```

The first command gives each linked crate with its version and license, and marks a
procedural macro with `(proc-macro)`; the second is the authoritative source for each
package's `license` field. Re-run both after changing `Cargo.toml` or refreshing
`Cargo.lock`.
