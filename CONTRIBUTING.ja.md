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

1. 管理者が **Bump-Version** を起動します（`workflow_dispatch`。入力は `level` と `version`）。ジョブは最新の正式版のタグ `vX.Y.Z` から次の版を求め、`packages/library/package.json` の版だけを変えるコミット `version up to vX.Y.Z` を1つ載せた枝 `release/vX.Y.Z` を push し、同じ題のプルリクエストを作ります。本文には、リリースノートの下書きが入ります。続けて、そのプルリクエストに対して **Review Thread Resolution** を起動し、`Check unresolved comments` を付けます。
2. プルリクエストは `PERSONAL_ACCESS_TOKEN` で作るので、CI が走ります（`GITHUB_TOKEN` で作ったプルリクエストでは `pull_request` のワークフローが起動しません）。必須のチェックが通ったら、管理者が squash でマージします。マージが公開の判断です。
3. `main` への push で、Bump-Version の `Tag the merged version` のジョブが起動します。版が変わっていないとき、または新しい版が正式版 `X.Y.Z` でないときは、何もしません。それ以外のときは、`.github/release-gate.py` がマージのコミットを確かめます。
   - このリポジトリの枝 `release/vX.Y.Z` から `main` へのプルリクエストを squash したものであること
   - `packages/library/package.json` の版だけを変えていること
   - 版が、前の版と最新の正式版のタグより大きいこと
   - `main` から到達できること

   マージの直後は、コミットと PR の関連付けが GitHub からすぐに返らないことがあるので、PR の照会は約10秒おきに5回まで行います。どれかが通らなければ、ジョブは失敗し、タグは打ちません。すべて通れば、マージのコミットにタグを打ち、`PERSONAL_ACCESS_TOKEN` で push します（`GITHUB_TOKEN` で push したタグでは、ワークフローが起動しません）。タグのジョブは1つずつ動きます。
4. タグの push で **Release** が起動します。Release は1つずつ動きます。Release は、タグと package.json の版の一致を確かめ、タグのコミットに同じ関門をかけ、npm にその版がまだないこと、版が npm の `latest` より大きいことを確かめます。そのあとビルドし、より新しい正式版のタグが現れていないことをもう一度確かめてから、provenance つきで npm に公開し（trusted publishing）、npm がその版を `latest` として、provenance つきで返すことを確かめます。最後に、`github-release` のジョブが、リリースノートつきの GitHub のリリース `Release vX.Y.Z` を作ります。

Release を `tag: vX.Y.Z` で手で起動しても、同じ確認が走ります。ただし provenance は付きません。

タグのジョブと Release は、それぞれ concurrency のグループで順番を待ちます。GitHub がグループごとに待たせておく実行は1つだけで、待っている間に3つ目が来ると、待っていた実行は取り消されます。直し方は下の表にあります。

前提：`PERSONAL_ACCESS_TOKEN` に、このリポジトリで枝とタグを push する権限と、プルリクエストを作る権限があること。ほかの手順は `GITHUB_TOKEN` を使います。

### リリースが途中で止まったとき

順番は、版上げのプルリクエスト、マージ、タグ、npm、GitHub のリリースです。npm への公開は関門を通ったタグからしか行わないので、「npm に出たのにタグがない」状態は起きません。npm の状態は `npm view event-store-adapter-js@X.Y.Z version dist-tags dist.attestations` で確かめます。

| 状態 | 直し方 | 再実行して安全か |
|---|---|---|
| Bump-Version が枝の push の前に失敗した（版が不正、タグがある、枝がある） | 原因を直して、Bump-Version を起動し直します。 | 安全です。何も変わっていません。 |
| 枝 `release/vX.Y.Z` はあるが、プルリクエストがない | 枝からプルリクエストを手で作る（題は `version up to vX.Y.Z`）か、枝を消して Bump-Version を起動し直します。 | 枝を消すまで、2回目の実行は `Check that the version branch is free` で止まります。 |
| プルリクエストに `Check unresolved comments` が付かない（枝を更新した後も含む） | Review Thread Resolution を、`pr_number` にプルリクエストの番号を入れて手で起動します。状態は先端のコミットに付くので、枝を更新するたびに起動し直します。 | 安全です。 |
| プルリクエストを公開したくない、またはチェックが失敗した | プルリクエストを閉じて枝を消します。`main` が進んだときは、プルリクエストの画面から枝を更新します。 | 安全です。マージまで `main` は変わりません。 |
| `Tag the merged version` が `no pull request is associated` または `could not read the pull requests` で失敗した | GitHub がコミットと PR を間に合うように関連付けなかったか、API が失敗しました。タグは打たれていません。失敗したジョブを再実行します。 | 安全です。 |
| `Tag the merged version` が関門のほかの確認で失敗した（ほかのプルリクエストが版を変えた、版が下がった、など） | タグも公開もされていません。版をプルリクエストで元に戻します。 | 該当しません。 |
| タグのジョブか Release の実行が、concurrency のグループで待つ間に取り消された | 取り消された実行を再実行します。 | 安全です。確認はやり直されます。 |
| 版は `main` に入ったが、タグがない（`Tag the merged version` が関門の後で失敗した、または起動しなかった） | その Bump-Version の実行の、失敗したジョブを再実行します。実行がなければ、マージのコミットに手でタグを push します：`git tag -a vX.Y.Z <マージのコミット> -m vX.Y.Z` と `git push origin vX.Y.Z`。Release がそのタグに関門をかけるので、ほかのコミットに打ったタグは公開されません。直すまで、次の版上げのプルリクエストを作らないでください。 | 安全です。タグが同じコミットにあれば、ジョブは何もしません。 |
| タグはあるが、Release の実行が始まらなかった | npm にその版がなければ、リモートのタグを消して（`git push origin :refs/tags/vX.Y.Z`）、`Tag the merged version` を再実行します。新しいタグの push で、provenance つきで公開されます。Release を `tag: vX.Y.Z` で手で起動しても直せますが、provenance は付きません。 | npm にその版がない間は安全です。 |
| タグはあるが、npm に版がない（Release が `publish` の前に失敗した） | その Release の実行の、失敗したジョブを再実行します。タグの push の実行のままなので、provenance が付きます。 | 安全です。 |
| Release が `publish` の途中か後で失敗した | npm を確かめます。npm に版がなければ、失敗したジョブを再実行します。npm に版があれば、再実行は意図して `Check that the version is not on npm yet` で止まります。provenance があることを確かめ、`dist-tags.latest` を見ます。`latest` がこの版より古いときだけ、`npm dist-tag add event-store-adapter-js@X.Y.Z latest` で直します。より新しい版が既に `latest` なら、触りません。そのうえで、GitHub のリリースを手で作ります：`gh release create vX.Y.Z --verify-tag --title "Release vX.Y.Z"`。ノートは `.github/create-release-note-header.py` と `.github/create-release-note-body.py` で作ります。 | 再実行で2回公開されることはありません。 |
| npm には出たが、GitHub のリリースがない（`github-release` が失敗した） | その Release の実行の、失敗したジョブを再実行します（`github-release` だけが再び走ります）。前のタグは、その版より小さい最大の正式版のタグなので、祖先である必要はありません。前のタグがなければ、ノートは最初のコミットから数えます。 | 安全です。リリースがあれば、ジョブは何もしません。 |

English version: [CONTRIBUTING.md](CONTRIBUTING.md)
