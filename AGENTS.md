# AGENTS.md

## 言語

- 日本語でやりとりすること。

## GitHub Pull Request のモニタリング

PR を作成したらモニタリングすること。
PRを監視・対応する際は、以下をすべて守ること。

- **コメントへの対応**
    - 監視待機中も定期的に新しいコメントが投稿されていないか確認する。
    - すべてのコメントを無視せず、必ず適切に対処する。
    - 対処方法としては、コメントの指摘内容をコードに反映した上でその旨をコメントに返信する。コメントの指摘内容が妥当でない場合は、非対応である旨をコメントに返信する。
- **テストカバレッジ**
    - カバレッジエラーを無視せず、必ず適切に対処する。（解決方法としてcodecov.ymlを変更しないこと)
- **マージ準備**
    - マージに必要な作業はすべて実施する。
- **マージの実行**
    - マージ操作自体は実行せず、人間に委譲する。

## `$grill-me` 実行時の作業判断

`$grill-me` で実施すべき作業内容が決まったら、その規模に応じて以下のいずれかを選択すること。

### 軽い作業の場合
- プランモードを用いず、そのまま作業に着手する。

### 複雑または重い作業の場合

- `$openspec-propose` を呼び出して change を作成する。
- 単一の change では大きすぎる場合は、複数の change に分割する。
- 分割した場合は、以下の成果物を生成すること。
    - `docs/plan/${date}_${epic-name}.md`
        - 各 change の概要をまとめたインデックスドキュメント
    - 各 change ファイル
        - 分割した change それぞれを個別に生成

Read these rules before implementing:

- COMMON.md
- .agents/rules/**/*.md

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.