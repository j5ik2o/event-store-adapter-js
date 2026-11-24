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

- DynamoDB・Spanner・Bigtable の試験、DynamoDB のサンプルには Docker が必要です ([packages/library/README.ja.md](packages/library/README.ja.md) を参照)。SQLite の試験はローカルのファイルだけを使い、Docker は不要です。ただし、同梱の `node:sqlite` が SQLite 3.51.3 以上を提供する Node.js 24.15 以上が必要です。
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
- 版上げは、手動で起動する Bump-Version ワークフローが、版上げのプルリクエストを作って行います。ほかのプルリクエストで `packages/library/package.json` の版を変えないでください。版の変更が `main` に入ると、公開が始まります。
- タグ `vX.Y.Z` を push すると Release ワークフローが起動し、ライブラリを npm に公開します。
- `main` からのビルドは公開しません。npm に公開された正式版を使ってください。リリースとリリースの間、`main` の版は最後に公開した版のままです（以前の `main` のコミットには `-snapshot.N` が付いています）。

### リリースの流れ

`main` は保護されています（必須のチェックは `CI Success` と `Check unresolved comments`。管理者にも適用）。そのため、どのワークフローも `main` へ push しません。

1. 管理者が **Bump-Version** を起動します（`workflow_dispatch`。入力は `level` と `version`）。ジョブは次の版を求め、`packages/library/package.json` だけを変えるコミット `version up to vX.Y.Z` を1つ載せた枝 `release/vX.Y.Z` を push し、同じ題のプルリクエストを作ります。本文には、リリースノートの下書きが入ります。続けて、そのプルリクエストに対して **Review Thread Resolution** を起動し、`Check unresolved comments` を付けます。
2. プルリクエストは `PERSONAL_ACCESS_TOKEN` で作るので、CI が走ります（`GITHUB_TOKEN` で作ったプルリクエストでは `pull_request` のワークフローが起動しません）。必須のチェックが通ったら、管理者が squash でマージします。マージが公開の判断です。
3. `main` への push で、Bump-Version の `Tag the merged version` のジョブが起動します。`.github/release-trigger.py` が push の前後の版を比べ、版が変わった、正式版 `X.Y.Z` である、タグがまだない、最新のタグより大きい、のすべてを満たすときだけ、マージ後の `main` のコミットにタグを打ちます。タグは `PERSONAL_ACCESS_TOKEN` で push します（`GITHUB_TOKEN` で push したタグでは、ワークフローが起動しません）。
4. タグの push で **Release** が起動します。タグと package.json の版の一致を確かめ、ビルドし、provenance つきで npm に公開します（trusted publishing）。公開が成功したら、`github-release` のジョブが、リリースノートつきの GitHub のリリース `Release vX.Y.Z` を作ります。

前提：`PERSONAL_ACCESS_TOKEN` に、このリポジトリで枝とタグを push する権限と、プルリクエストを作る権限があること。

### リリースが途中で止まったとき

どの手順も、完了するか、下のどれかの状態で止まります。順番は、版上げのプルリクエスト、マージ、タグ、npm、GitHub のリリースです。npm への公開はタグからしか行わないので、「npm に出たのにタグがない」状態は起きません。

| 状態 | 直し方 | 再実行して安全か |
|---|---|---|
| Bump-Version が枝の push の前に失敗した（版が不正、タグがある、枝がある） | 原因を直して、Bump-Version を起動し直します。 | 安全です。何も変わっていません。 |
| 枝 `release/vX.Y.Z` はあるが、プルリクエストがない | 枝からプルリクエストを手で作る（題は `version up to vX.Y.Z`）か、枝を消して Bump-Version を起動し直します。 | 枝を消すまで、2回目の実行は `Check that the version branch is free` で止まります。 |
| プルリクエストに `Check unresolved comments` が付かない | Review Thread Resolution を、`pr_number` にプルリクエストの番号を入れて手で起動します。 | 安全です。 |
| プルリクエストを公開したくない、またはチェックが失敗した | プルリクエストを閉じて枝を消します。`main` が進んだときは、プルリクエストの画面から枝を更新します。 | 安全です。マージまで `main` は変わりません。 |
| 版は `main` に入ったが、タグがない（`Tag the merged version` が失敗した） | その Bump-Version の実行の、失敗したジョブを再実行します。実行がなければ、手でタグを push します：`git tag -a vX.Y.Z <マージのコミット> -m vX.Y.Z` と `git push origin vX.Y.Z`。直すまで、次の版上げのプルリクエストを作らないでください。 | 安全です。タグがあれば、ジョブは何もしません。 |
| タグはあるが、npm に出ていない（Release が `publish` の前か途中で失敗した） | その Release の実行の、失敗したジョブを再実行します。タグの push の実行のままなので、provenance が付きます。Release を `tag: vX.Y.Z` で手で起動しても直せますが、provenance は付きません。 | 安全です。npm は同じ版を2回公開しません。 |
| npm には出たが、GitHub のリリースがない（`github-release` が失敗した） | その Release の実行の、失敗したジョブを再実行します（`github-release` だけが再び走ります）。 | 安全です。リリースがあれば、ジョブは何もしません。 |
| `Tag the merged version` が `must be greater than the latest tag` で失敗した | マージした版が最新のタグより新しくありません。プルリクエストでマージを取り消します。タグも公開もされていません。 | 該当しません。 |

English version: [CONTRIBUTING.md](CONTRIBUTING.md)
