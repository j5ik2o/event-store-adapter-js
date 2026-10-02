{extends:scenario-based-plan}

## DDD モデルの変更

プロジェクトは DDD の設定を `.ddd.toml` に、モデルを `docs/ddd/domain-model.yaml`、`docs/ddd/aggregate-mapping.yaml`、`docs/ddd/layer-structure.yaml` に持つ。計画はこれらのファイルへの変更を正確に示し、実装はそれをコードより先に反映する。

- 4 つのファイルを読む。`.ddd.toml` がなければ、変更が触れる言語、Rust の `module_layout = "file"`、TypeScript の `module_layout = "named-file"` と `code_representation = "class"` で作る計画にする。要求が別の選択を示していればそれに従う。既存のファイルから配置を推測しない。モデルのファイルがなければ作る計画にする。
- 要求の業務上の振る舞いを、次の順で導く。過去形のドメインイベント、それを生むコマンドとアクター、その状態を変える集約、集約をまとめる不変条件。
- 既存の要素 ID を再利用する。ID は改名しない。改名は `name` だけを変える。分割、統合、廃止はすべて `lineage` に記録する。
- `## DDD Model Changes` の節を設け、ファイルごとに追加・変更する YAML を書く。
  - ドメインモデル: 追加・変更する集約とその不変条件、追加・変更するコマンドとファクトリ規則それぞれのドメインエラー、状態効果、遷移、コマンドが生む 1 つのイベント（`event`）、冪等性の戦略
  - 集約写像: 各集約の `programming_model` と `persistence_method`、パッケージ、モジュールのパス、型、ポート、リポジトリ。各操作のメソッド、エラー型、エラーの case、各コマンドの `success_type`。イベントソーシングの集約の `replay_methods`。変更がコードを置くすべてのパッケージとモジュールの階層について、業務用語、モデル参照、根拠を持つ `domain_packages` の項目
  - 層構造: 変更が追加・変更するパッケージ、依存、ポート、リポジトリ、復元経路
- `## DDD Use Cases` の節を設け、変更が追加・変更するユースケースごとに、`use_case_id`、`name`、`target_aggregates`、`commands`、`re_execution_basis`、`recovery_policy`、複数の集約を対象にするときの `multi_aggregate_strategy`、`read_model_exposure` を宣言する。
- 完了契約表では、最初の行で DDD モデルの変更を反映する。実装の各行は実装するモデル ID を引用し、実装箇所は集約写像と選んだモジュール配置に従う。
- Domain Primitive ごとに値の規則を決める。規則があれば、その Primitive を `element` に取る不変条件と、それを組み立てて規則違反をエラーで返すファクトリ規則を宣言する。規則がなければ `unconstrained` に理由を書く。要求が規則を決めていないときは、その概念で一般的な規則を前提として置くか、`unconstrained` を理由とともに宣言し、どちらも未決事項に挙げる。規則を黙って省かない。
- 要求が業務上の規則（不変条件、エラーの条件、冪等性の要件）を決めていないときは、計画が置く前提とともに未決事項として挙げる。作り出した規則を要件として示さない。
- `.takt/` の中は読まない。DDD の規則はこのステップに渡された policy と knowledge にあり、ddd-lint の検査はソースを読まず実行して確かめる。
