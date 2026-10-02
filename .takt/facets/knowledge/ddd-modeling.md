# DDD モデリング知識

## プロジェクトのファイル

DDD のプロジェクトは、タスクをまたいで育てるモデルと設定をファイルで持つ。

| ファイル | 役割 |
|----------|------|
| `.ddd.toml`（リポジトリ直下） | 言語と、言語ごとの選択（モジュール配置と TypeScript のコード表現） |
| `docs/ddd/domain-model.yaml` | ドメインモデル宣言。業務概念の唯一の定義 |
| `docs/ddd/aggregate-mapping.yaml` | モデルの各要素がコードのどこにあるか、およびドメインパッケージの業務語彙 |
| `docs/ddd/layer-structure.yaml` | 境界づけられたコンテキストごとのパッケージ、役割と依存、ポート、リポジトリ、復元経路 |

### .ddd.toml

```toml
languages = ["rust", "typescript"]

[rust]
module_layout = "file"            # または "mod-rs"

[typescript]
module_layout = "named-file"      # または "index-file"
code_representation = "class"     # または "companion"
```

挙げた言語のテーブルだけを置く。新しいプロジェクトでは `file` と `named-file` が一般的な選択である。

### ドメインモデル宣言

```yaml
bounded_contexts:
  - element_id: bc.billing
    name: Billing
    aggregates:
      - element_id: aggregate.invoice
        name: Invoice
        bounded_context: bc.billing
        root_element: entity.invoice
        states: [draft, issued]
        elements:
          - { element_id: entity.invoice, kind: entity, name: Invoice, aggregate: aggregate.invoice }
          - { element_id: vo.invoice-line, kind: value-object, name: InvoiceLine, aggregate: aggregate.invoice }
          - { element_id: primitive.customer-id, kind: domain-primitive, name: CustomerId, aggregate: aggregate.invoice, attributes: [{ name: value, type: string, required: true }] }
          - { element_id: primitive.money, kind: domain-primitive, name: Money, aggregate: aggregate.invoice, unconstrained: "値引きの明細があるので、個々の明細金額は正にも 0 にも負にもなる", attributes: [{ name: value, type: decimal, required: true }] }
        invariants:
          - { element_id: invariant.invoice.customer-id-format, name: CustomerIdFormat, aggregate: aggregate.invoice, element: primitive.customer-id, statement: 顧客 ID は C に続く 6 桁の数字である }
          - { element_id: invariant.invoice.total-not-negative, name: TotalNotNegative, aggregate: aggregate.invoice, statement: 明細の合計は負にならない }
          - { element_id: invariant.invoice.issued-has-lines, name: IssuedHasLines, aggregate: aggregate.invoice, statement: 発行済みの請求書は明細を 1 件以上持つ }
        commands:
          - element_id: command.invoice.add-line
            name: AddLine
            aggregate: aggregate.invoice
            effect: accumulation
            state_effect: none
            domain_errors:
              - { element_id: error.invoice.add-line.already-issued, name: AlreadyIssued, operation: command.invoice.add-line, condition: 請求書は発行済みである }
              - { element_id: error.invoice.add-line.negative-total, name: NegativeTotal, operation: command.invoice.add-line, condition: 追加すると合計が負になる }
            event: event.invoice.line-added
            idempotency: { strategy: command-id-memory, retention: last-one, rationale: "クライアントは前の明細追加の応答を受けてから次の明細追加を送るので、古い明細追加が新しい明細追加の後に再送されることはない" }
          - element_id: command.invoice.issue
            name: Issue
            aggregate: aggregate.invoice
            effect: transition
            state_effect: transitions
            transitions: [transition.invoice.issue]
            domain_errors:
              - { element_id: error.invoice.issue.already-issued, name: AlreadyIssued, operation: command.invoice.issue, condition: 請求書は発行済みである }
              - { element_id: error.invoice.issue.empty-lines, name: EmptyLines, operation: command.invoice.issue, condition: 明細がない }
            event: event.invoice.issued
            idempotency: { strategy: none }
        events:
          - { element_id: event.invoice.line-added, name: LineAdded, aggregate: aggregate.invoice, produced_by: command.invoice.add-line }
          - { element_id: event.invoice.issued, name: Issued, aggregate: aggregate.invoice, produced_by: command.invoice.issue }
        transitions:
          - { element_id: transition.invoice.issue, name: Issue, aggregate: aggregate.invoice, from_state: draft, to_state: issued, command: command.invoice.issue }
        factory_rules:
          - element_id: factory.invoice.open
            name: Open
            target_element: entity.invoice
            preconditions: [invariant.invoice.total-not-negative]
            domain_errors:
              - { element_id: error.invoice.open.negative-total, name: NegativeTotal, operation: factory.invoice.open, condition: 明細の合計が負になる }
          - element_id: factory.invoice.parse-customer-id
            name: ParseCustomerId
            target_element: primitive.customer-id
            preconditions: [invariant.invoice.customer-id-format]
            domain_errors:
              - { element_id: error.invoice.parse-customer-id.invalid-format, name: InvalidFormat, operation: factory.invoice.parse-customer-id, condition: 値が C に続く 6 桁の数字ではない }
lineage: []
```

要素 ID は小文字のケバブケースで `<kind>.<segments>` と書く。`bc`、`aggregate`、`entity`、`vo`、`primitive`、`pm` は区切り 1 つ、`invariant`、`command`、`event`、`transition`、`factory` は集約と名前の 2 つ、`error` は集約、操作、名前の 3 つをとる。`lineage` の項目（`lineage-0001`、関係は `renamed`、`split`、`merged`、`deprecated`）が ID の変化を記録する。

Domain Primitive（`kind: domain-primitive`）は属性を 1 つだけ包み、値の規則を宣言する。規則があれば、`element` でその Primitive を指す不変条件と、それを `target_element` に取って規則違反をエラーとして返すファクトリ規則の両方を書く（上の `primitive.customer-id`、`invariant.invoice.customer-id-format`、`factory.invoice.parse-customer-id`）。規則がなければ、要素に `unconstrained` と理由を書く（上の `primitive.money`）。どちらも書かないこと、両方を書くことはしない。`collection: true` の属性は、コードではファーストクラスコレクションの型で持つ。

### 集約写像

```yaml
model_ref: domain-model.yaml
aggregate_mappings:
  - aggregate_ref: aggregate.invoice
    programming_model: class
    persistence_method: state-sourcing
    reference_ids: [entity.invoice]
    code: { language: typescript, package: "@acme/billing-domain", module: [invoice], type: Invoice }
    operations:
      - operation_ref: factory.invoice.open
        code: { method: open, error_type: OpenInvoiceError }
        errors:
          - { error_ref: error.invoice.open.negative-total, code: { case: negative-total } }
      - operation_ref: factory.invoice.parse-customer-id
        code: { method: parse, error_type: ParseCustomerIdError }
        errors:
          - { error_ref: error.invoice.parse-customer-id.invalid-format, code: { case: invalid-format } }
      - operation_ref: command.invoice.add-line
        code: { method: addLine, success_type: AddInvoiceLineOutcome, error_type: AddInvoiceLineError }
        errors:
          - { error_ref: error.invoice.add-line.already-issued, code: { case: already-issued } }
          - { error_ref: error.invoice.add-line.negative-total, code: { case: negative-total } }
      - operation_ref: command.invoice.issue
        code: { method: issue, success_type: IssueInvoiceOutcome, error_type: IssueInvoiceError }
        errors:
          - { error_ref: error.invoice.issue.already-issued, code: { case: already-issued } }
          - { error_ref: error.invoice.issue.empty-lines, code: { case: empty-lines } }
domain_packages:
  - { term: 請求, model_refs: [bc.billing], rationale: 請求の業務全体を持つ, code: { language: typescript, package: "@acme/billing-domain", module: [] } }
  - { term: 請求書, model_refs: [aggregate.invoice], rationale: 請求書を作成し発行する, code: { language: typescript, package: "@acme/billing-domain", module: [invoice] } }
  - { term: 請求書明細, model_refs: [vo.invoice-line, primitive.money], rationale: 請求書が合計する金額, code: { language: typescript, package: "@acme/billing-domain", module: [invoice, line] } }
  - { term: 請求書明細の並び, model_refs: [vo.invoice-line], rationale: 1 通の請求書の明細とその合計, code: { language: typescript, package: "@acme/billing-domain", module: [invoice, lines] } }
  - { term: 顧客 ID, model_refs: [primitive.customer-id], rationale: 請求書の請求先の顧客を識別する, code: { language: typescript, package: "@acme/billing-domain", module: [customer-id] } }
```

`model_ref` は `docs/ddd` からの相対パスで書く。`success_type` はコマンドが成功時に返すものの型名である。TypeScript では新しいインスタンスとイベントを持つ成功値の型、Rust ではイベント、再送されたコマンドを認識するコマンドでは成功値の enum になる。ファクトリ規則の成功値は集約の型である。`module` はパッケージのルートより下の区切りを並べたもので、ルートは `[]` になる。ルートから下のすべての階層を宣言する。TypeScript では case の文字列がリテラルの union のメンバー（`already-issued`）になり、Rust では enum のバリアント（`AlreadyIssued`）になる。

### 層構造

```yaml
model_ref: domain-model.yaml
layer_structures:
  - context_ref: bc.billing
    cqrs: false
    packages:
      - { role: command, code: { language: typescript, package: "@acme/billing-domain" } }
      - { role: command, code: { language: typescript, package: "@acme/billing-use-case" } }
      - { role: command, code: { language: typescript, package: "@acme/billing-interface-adapter" } }
    dependencies:
      - { code: { language: typescript, package: "@acme/billing-domain" }, depends_on: [{ language: typescript, package: "@acme/language-extensions" }] }
      - { code: { language: typescript, package: "@acme/billing-use-case" }, depends_on: [{ language: typescript, package: "@acme/billing-domain" }, { language: typescript, package: "@acme/language-extensions" }] }
      - { code: { language: typescript, package: "@acme/billing-interface-adapter" }, depends_on: [{ language: typescript, package: "@acme/billing-domain" }, { language: typescript, package: "@acme/billing-use-case" }, { language: typescript, package: "@acme/language-extensions" }] }
    ports:
      - { name: InvoiceRepository, kind: repository, verbs: [findById, store] }
    repositories:
      - { name: InvoiceRepository, aggregate_ref: aggregate.invoice, io_unit: single, verbs: [findById, store], store_semantics: upsert }
    restoration_paths:
      - { aggregate_ref: aggregate.invoice, via: full-constructor }
    persistence_backend: in-memory
```

`packages` はコンテキスト自身のパッケージを CQRS の側（`role`）とともに並べる。言語拡張（`@acme/language-extensions`）のようにコンテキストの外にある共有パッケージは、どの側にも立たないので `packages` に行を持たず、それを使うパッケージの `depends_on` にだけ書く。依存行には、そのパッケージの `package.json` や `Cargo.toml` が直接依存するパッケージをすべて書く。

永続化を持たない集約だけのコンテキストでも、パッケージ、依存行、復元経路は宣言する。`ports: []`、`repositories: []`、`persistence_backend: none` は明示的に記述できる。

## モデルの導き方

モデルはデータの表からではなく振る舞いから導く。ストーリーから過去形のドメインイベントを挙げ、各イベントを生むコマンドとアクターを特定し、同じ状態を変えるイベントを集約にまとめる。集約の不変条件が、それらが一緒にある理由を説明する。

| 条件 | 意味・選択肢 |
|------|-------------|
| 候補が守る不変条件を述べられない | 別の集約へ統合するか、値や Entity に格下げする |
| 規則を守るために 2 つの候補が一緒に変わる必要がある | 1 つの集約にする。分けたままにするなら Process Manager |
| フローが集約をまたぐ | Process Manager の候補。ステップと補償をモデルに記録する |
| 操作が状態を変えない | `state_effect: none` とする。これは有効な宣言である |
| 用語がコードにだけあり、業務の語彙にない | パッケージの名前にする前に意味を確かめる |

## 集約ごとの二軸

実行モデルと永続化は独立した選択であり、どちらも TypeScript のコード表現とは独立している。

| 軸 | 値 | 意味 |
|----|----|------|
| `programming_model` | `class` | 集約はユースケースから呼ばれるオブジェクト |
| | `actor` | 集約はメッセージを受け取る。複数集約のフローには Process Manager が要る |
| `persistence_method` | `state-sourcing` | 現在の状態を保存する。`store` は期待バージョン付きで再永続化する |
| | `event-sourcing` | イベントを追記する。状態は宣言した replay メソッドで再生して組み立てる |

状態を変えるコマンドは、永続化の方式にかかわらず、生んだ 1 つのイベントを返す。イベントソーシングでは、コマンドは宣言した replay メソッドを通して状態を変え、復元は保存済みのイベントを同じメソッドで再生する。replay メソッドは何も判断しない。

## 冪等性と回復

| 条件 | 意味・選択肢 |
|------|-------------|
| `effect: transition` | 同じコマンドを繰り返しても目的の状態に達しているので、遷移そのものが守る |
| `effect: accumulation` | 繰り返すと二重に加わる。コマンド ID を記憶する（`command-id-memory`）。古いコマンドが新しいコマンドの後に再送されない理由を `rationale` に書けるなら最後の 1 件（`last-one`）、書けなければ複数件（`multiple`）か時間窓（`time-window`）で保持する |
| 直前のコマンド ID だけを覚えている | C2 の後に届いた C1 の再送を防げない |
| 永続化の結果が不明 | 再試行する前にコマンド ID で照合する |
| 複数集約のフローが途中で失敗する | 先のコミットは残る。再実行か補償で回復する。補償は新しい業務操作である |

| 回復方針 | 意味 |
|----------|------|
| `caller-retry` | 呼び出し側がユースケース全体を安全に再試行する |
| `step-backoff` | 失敗したステップを間隔を空けて再試行する |
| `both` | 両方の仕組みを使う |

計画で宣言するユースケースは、`use_case_id`（`uc.<slug>`）、`name`、`target_aggregates`、`commands`、`re_execution_basis`、`recovery_policy`、複数の集約を対象にするときの `multi_aggregate_strategy`（`pm.*` を参照する `process-manager`、または根拠を添えた `re-execution`）、`read_model_exposure` を持つ。

## CQRS と読み取りモデル

| 条件 | 意味・選択肢 |
|------|-------------|
| 集約が持たない形の問い合わせが必要 | DAO と DTO を持つクエリ側を置き、読み取りモデル更新器で更新する |
| 読み取りモデルを非同期に更新する | 古い可能性がある。呼び出し側が依存する箇所では遅延を明示する |
| イベントが順不同や重複で届く | 集約内の番号と処理済みのイベント ID を追跡し、更新と処理済みの記録を原子的に確定する |
| 更新に別の集約の事実が要る | その集約を読み込むか、Process Manager に調整させる。読み取りモデルは判断の根拠にしない |

## 層

| 層 | 置くもの | 依存先 |
|----|----------|--------|
| domain | 集約、Entity、値オブジェクト、Domain Primitive、状態を持たないドメインサービス | infrastructure |
| use-case | ポート（リポジトリポートと、層構造が宣言するほかのポート）。読み込み、ドメイン操作の呼び出し、保存、回復。コマンド側の `execute(ID, 値)`、クエリのユースケース | domain、infrastructure |
| interface-adapter | コントローラ、リポジトリ実装、DAO、データベースと RPC のクライアント | use-case、domain、infrastructure |
| infrastructure | 言語拡張だけ（TypeScript の `Result` など） | なし |
| composition root | 実装とポートの結線 | すべての層 |
| 読み取りモデル更新器 | イベントを読み取りモデルへ投影する | 両側 |

クエリ側は use-case と interface-adapter の層だけを持ち、自分のドメイン層を持たない。
