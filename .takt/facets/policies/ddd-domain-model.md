# DDD ドメインモデルポリシー

`docs/ddd/` の宣言（ドメインモデル、集約写像、層構造）に何を書くかと、宣言とコードの順序を定める。コードが宣言と一致するかはドメイン層ポリシーが判定する。

## ドメインモデル（`docs/ddd/domain-model.yaml`）

| 基準 | 判定 |
|------|------|
| 集約、要素、不変条件、コマンド、ファクトリ規則、イベント、エラー、状態を、ドメインモデルの外（写像、計画、コード、レビュー）で定義している | REJECT。ドメインモデルに定義し、ほかはモデル ID で引用する |
| 不変条件を持たない集約がある | REJECT。候補を統合するか格下げする |
| コマンドが状態効果（`transitions` か `none`）を宣言していない、または宣言と遷移が食い違う | REJECT |
| コマンドがイベントを宣言していない、2 つ以上宣言している（`events: [...]`）、またはその `event` を別のコマンドが生む | REJECT。コマンドが生むイベントはちょうど 1 つ（`event: <イベント ID>`） |
| コマンドやファクトリ規則にドメインエラーがない、または別の操作が所有するエラーを指している | REJECT |
| `effect: accumulation` のコマンドに `command-id-memory` の冪等性戦略がない | REJECT |
| `retention: last-one` のコマンドに、古いコマンドが新しいコマンドの後に再送されない理由（`C1 → C2 → C1 の再送`）を書いた `rationale` がない | REJECT。再送され得るなら `multiple` か `time-window` を選ぶ |
| Domain Primitive が値の規則（`element` でその Primitive を指す不変条件と、それを `target_element` に取るファクトリ規則）も、規則がないことの宣言（`unconstrained` と理由）も持たない、または両方を持つ | REJECT。どちらか一方を宣言する |
| 要素の属性が、他の集約の要素を ID ではなく型として持っている | REJECT。他の集約は ID で参照する |
| 要素 ID を改名した、廃止後に再利用した、または `<kind>.<segments>` の形式に従っていない | REJECT。改名は `name` だけを変える |
| 分割・統合・廃止が `lineage` に記録されていない | REJECT |
| モデルがモジュール、パッケージ、ポート、リポジトリ、ユースケースの手順を決めている | REJECT。集約写像と層構造に書く |

## 集約写像（`docs/ddd/aggregate-mapping.yaml`）

| 基準 | 判定 |
|------|------|
| モデルの集約に写像の行がない | REJECT |
| 集約が `programming_model`（`actor` か `class`）と `persistence_method`（`state-sourcing` か `event-sourcing`）を宣言していない | REJECT |
| コマンドやファクトリ規則にメソッドとエラー型がない、コマンドに `success_type` がない、またはドメインエラーに case がない | REJECT |
| イベントソーシングの集約が、イベントを適用するメソッドを `replay_methods` に宣言していない | REJECT |
| ドメインのコードを置くパッケージやモジュール、またはその親の階層が `domain_packages` にない | REJECT |
| `domain_packages` の項目に業務用語、モデル参照、根拠のいずれかがない | REJECT |

## 層構造（`docs/ddd/layer-structure.yaml`）

| 基準 | 判定 |
|------|------|
| 変更がコードを置くパッケージ、その依存、ポート、リポジトリ、復元経路のいずれかが宣言されていない | REJECT。ただし `persistence_backend: none` の集約だけのコンテキストでは、`ports` と `repositories` の空配列を明示できる。依存行と復元経路は引き続き必須とする。言語拡張のようにコンテキストの外にある共有パッケージは `packages` に行を持たず、それを使うパッケージの `depends_on` にだけ書く |
| ポートが `repository`、`external-client`、`es-infrastructure` のいずれにも分類されていない | REJECT |

## 宣言とコードの順序

| 基準 | 判定 |
|------|------|
| 業務の振る舞いを追加・変更するのに、宣言より先にコードを変えている | REJECT。先に宣言を更新する |
| 正しいコードを書くのに必要な宣言が欠けている | 欠けている宣言を記録する。コードで作り出さない |
| モデルとプロジェクトの明示的な方針が衝突する | どちらも黙って上書きしない。衝突、範囲、解決を記録する |
