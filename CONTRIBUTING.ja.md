> この文書は [CONTRIBUTING.md](CONTRIBUTING.md) の日本語版です。英語版が正本で、食い違うときは英語版に従います。

# event-store-adapter-js への貢献

## 概要

この案内は、このリポジトリに変更を加える開発者向けです。ライブラリの使い方は [README.ja.md](README.ja.md) と [packages/library/README.ja.md](packages/library/README.ja.md) を参照してください。

リポジトリは 3 つのパッケージからなる pnpm workspace です。

- `packages/library`: 公開するライブラリ (`event-store-adapter-js`)
- `packages/examples`: 実行できるサンプル
- `packages/tests`: ビルド・pack したライブラリを利用する試験

## 共有する契約と設計判断

すべての言語実装が共有する契約と、その根拠となる設計判断は、ハブのリポジトリ j5ik2o/event-store-adapter にあります。

- 仕様: <https://github.com/j5ik2o/event-store-adapter/tree/main/docs/spec>
- 設計判断の記録 (ADR): <https://github.com/j5ik2o/event-store-adapter/tree/main/docs/adr>

`conformance/` と `api-surface/surface.json` はハブのファイルの写しで、CI が固定した SHA-256 の値と照合します。このリポジトリでは編集しないでください。

## ローカルの準備

- Node.js 24 以上 (`package.json` の `engines`。`.mise.toml` は `node = "24"`)。
- pnpm 12.15.0 (`package.json` の `packageManager`)。CI は `corepack enable` で有効にします。
- 依存の導入は CI と同じ手順で行います。

```shell
corepack enable
pnpm install --frozen-lockfile
```

- DynamoDB と Spanner の試験、DynamoDB のサンプルには Docker が必要です ([packages/library/README.ja.md](packages/library/README.ja.md) を参照)。
- 文書と適合データの検査には Python 3 が必要です。 `tools/user-docs/check.py` は Python 3.10 以上が必要です。

## 検査

リポジトリのルートで実行します。CI が実行する主なコマンドです。

| CI のジョブ | コマンド |
|:--|:--|
| `lint` | `pnpm run lint` |
| `test` | `pnpm run build`、続いて `pnpm --filter event-store-adapter-js run coverage --runInBand` |
| `examples` | `pnpm run test:examples` |
| `package-tests` | `pnpm run test:packages` |
| `release-checks` | `python3 tools/conformance/manifest.py verify`、`.github/workflows/ci.yml` に記載された固定の SHA-256 値との `sha256sum -c`、`python3 tools/user-docs/check.py`、`python3 -m unittest discover -s .github/tests -v` (`pip install semver` が必要)、`actionlint` (`go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12` で導入) |

ルートのその他のスクリプト: `pnpm run test` はライブラリの試験を実行し、`pnpm run fmt` と `pnpm run fix` は Biome でライブラリのソースを整形・修正します。

変更が文書のファイル (`*.md`、`docs/*`、`README*` など) だけの場合、コードの検査ジョブは skip され、`release-checks` は常に実行されます。

## 設計の記録

[docs/design/next-major.md](docs/design/next-major.md) ([日本語版](docs/design/next-major.ja.md)) は、v5 を作る際の設計の記録です。現在の使い方は README と現在のコードで確認してください。`openspec/` と `.kiro/` は歴史的な生成物です。

## 変更とリリース

- プルリクエストは `main` に向けて作成します。
- コミットの件名は Conventional Commits の形 (`type(scope): description`) で書きます。次の版の水準とリリースノートはこれから導かれます。
- 版上げは、手動で起動する Bump-Version ワークフローが行います。プルリクエストで `packages/library/package.json` の版を変えないでください。
- タグ `vX.Y.Z` を push すると Release ワークフローが起動し、ライブラリを npm に公開します。
- `main` で CI が成功すると、Snapshot ワークフローが `snapshot` の dist-tag で snapshot 版を公開します。

English version: [CONTRIBUTING.md](CONTRIBUTING.md)
