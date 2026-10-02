# DDD Rust 知識

## 集約

集約は、非公開のフィールド、状態全体を受け取る非公開のコンストラクタ、操作固有のエラー enum を返す検証付きのファクトリ、永続化された状態のための `restore` 関数、`&mut self` を取って状態を変え、生んだ 1 つのイベントを返すコマンドを持つ。失敗したコマンドは何も変えず、イベントも生まない。

```rust
pub mod line;
pub mod lines;

use self::line::{InvoiceLine, Money};
use self::lines::InvoiceLines;
use crate::customer_id::CustomerId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenInvoiceError {
    NegativeTotal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddInvoiceLineError {
    AlreadyIssued,
    NegativeTotal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueInvoiceError {
    AlreadyIssued,
    EmptyLines,
}

/// A persisted state the invariants forbid: corrupt storage, not a business failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CorruptInvoiceState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvoiceLineAdded {
    invoice_id: String,
    command_id: String,
    line: InvoiceLine,
}

impl InvoiceLineAdded {
    fn new(invoice_id: &str, command_id: &str, line: InvoiceLine) -> Self {
        InvoiceLineAdded { invoice_id: invoice_id.to_string(), command_id: command_id.to_string(), line }
    }

    pub fn invoice_id(&self) -> &str {
        &self.invoice_id
    }

    pub fn command_id(&self) -> &str {
        &self.command_id
    }

    pub fn line(&self) -> &InvoiceLine {
        &self.line
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvoiceIssued {
    invoice_id: String,
}

impl InvoiceIssued {
    fn new(invoice_id: &str) -> Self {
        InvoiceIssued { invoice_id: invoice_id.to_string() }
    }

    pub fn invoice_id(&self) -> &str {
        &self.invoice_id
    }
}

/// A command ID already applied changes nothing and produces no event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddInvoiceLineOutcome {
    Applied(InvoiceLineAdded),
    Duplicate,
}

#[derive(Debug, Clone)]
pub struct Invoice {
    id: String,
    customer: CustomerId,
    lines: InvoiceLines,
    issued: bool,
    last_add_line_command_id: Option<String>,
}

impl Invoice {
    fn new(
        id: String,
        customer: CustomerId,
        lines: InvoiceLines,
        issued: bool,
        last_add_line_command_id: Option<String>,
    ) -> Self {
        Invoice { id, customer, lines, issued, last_add_line_command_id }
    }

    pub fn open(id: &str, customer: CustomerId, lines: InvoiceLines) -> Result<Self, OpenInvoiceError> {
        if lines.total().is_negative() {
            return Err(OpenInvoiceError::NegativeTotal);
        }
        Ok(Self::new(id.to_string(), customer, lines, false, None))
    }

    pub fn restore(
        id: &str,
        customer: CustomerId,
        lines: InvoiceLines,
        issued: bool,
        last_add_line_command_id: Option<String>,
    ) -> Result<Self, CorruptInvoiceState> {
        if (issued && lines.is_empty()) || lines.total().is_negative() {
            return Err(CorruptInvoiceState);
        }
        Ok(Self::new(id.to_string(), customer, lines, issued, last_add_line_command_id))
    }

    pub fn add_line(&mut self, command_id: &str, line: InvoiceLine) -> Result<AddInvoiceLineOutcome, AddInvoiceLineError> {
        if self.last_add_line_command_id.as_deref() == Some(command_id) {
            return Ok(AddInvoiceLineOutcome::Duplicate);
        }
        if self.issued {
            return Err(AddInvoiceLineError::AlreadyIssued);
        }
        let mut total = self.lines.total();
        line.with_amount(|amount| total.add(amount));
        if total.is_negative() {
            return Err(AddInvoiceLineError::NegativeTotal);
        }
        self.lines.add(line.clone());
        self.last_add_line_command_id = Some(command_id.to_string());
        Ok(AddInvoiceLineOutcome::Applied(InvoiceLineAdded::new(&self.id, command_id, line)))
    }

    pub fn issue(&mut self) -> Result<InvoiceIssued, IssueInvoiceError> {
        if self.issued {
            return Err(IssueInvoiceError::AlreadyIssued);
        }
        if self.lines.is_empty() {
            return Err(IssueInvoiceError::EmptyLines);
        }
        self.issued = true;
        Ok(InvoiceIssued::new(&self.id))
    }

    pub fn is_billed_to(&self, customer: &CustomerId) -> bool {
        &self.customer == customer
    }

    pub fn total(&self) -> Money {
        self.lines.total()
    }

    pub fn lines(&self) -> InvoiceLines {
        self.lines.clone()
    }
}
```

`restore` は、壊れた状態を専用の型で知らせる。業務上の失敗ではないからである。`add_line` は最後に反映した明細追加のコマンド ID を記憶し（モデルは `retention: last-one` を宣言する）、再送されたコマンドをほかのどの判定より先に認識する。そのときは `AddInvoiceLineOutcome::Duplicate` を返し、何も変えず、イベントも生まないので、イベントが二重に公開されない。何かを変える前に、変えた後の合計を確かめる。イベントもドメイン型であり、フィールドは非公開、集約のモジュールの中で自分の `new` によって組み立て、公開する側には読み取り専用のアクセサを提供する。顧客は Domain Primitive `CustomerId`、明細金額は Domain Primitive `Money`、明細はファーストクラスコレクション `InvoiceLines` である。請求書 ID とコマンド ID は例を短く保つために `&str` のままにしている。

## その場での変更

ドメインの型の種類によらず、変わるものを `&mut` で受け取り、その場で変える。変わる値オブジェクト、Domain Primitive、コレクションは `&mut self` を取り、`()` を返す。変更が失敗し得るなら `Result<(), E>` を返す。ドメインメソッドは外部の `&mut` 引数を変更せず、変更の受け手自身を receiver にする。その禁止形は構文から検出するが、本体の文が実際に引数を変更するかまでは証明しない。`&self` や `self` を取って新しいインスタンスを返すことはせず、`Add` のような新しい値を返す演算子も実装しない。所有権があるので安全である。`&` で共有された値は変えられず、変える前の値が要る呼び出し側は先に `clone` する。集約の中の値の `&mut self` のメソッドはコマンドではなく、集約のコマンドがそれを呼ぶ。

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Money(i64);

impl Money {
    pub fn of(value: i64) -> Self {
        Money(value)
    }

    pub fn zero() -> Self {
        Money(0)
    }

    pub fn add(&mut self, rhs: &Money) {
        self.0 += rhs.0;
    }

    pub fn is_negative(&self) -> bool {
        self.0 < 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvoiceLine {
    amount: Money,
}

impl InvoiceLine {
    pub fn of(amount: Money) -> Self {
        InvoiceLine { amount }
    }

    pub fn with_amount<R>(&self, use_amount: impl FnOnce(&Money) -> R) -> R {
        use_amount(&self.amount)
    }
}
```

`Money` は Domain Primitive であり、モデルでは個々の明細金額を理由付きの `unconstrained` として宣言する。負の明細を別の明細で相殺できる一方、集約が合計の非負を守るためである。`Money::add` は受け手の `Money` 自身を `&mut self` で変更し、`InvoiceLine` は裸の値やgetterを公開せず、Domain Primitiveを操作へ渡す。その場での変更規則は外部の `&mut` 引数を拒否するが、通常の `&self` 問い合わせは許可する。

## Domain Primitive

Domain Primitive は値を 1 つ包み、値の規則を持つ。モデルは規則を、その Primitive を指す不変条件と、それを組み立てるファクトリ規則として宣言する。ファクトリは規則を確かめ、そのファクトリ固有のエラー enum を返すので、存在する `CustomerId` は常に正しい。等価は値で決まる。

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseCustomerIdError {
    InvalidFormat,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomerId(String);

impl CustomerId {
    pub fn parse(value: &str) -> Result<Self, ParseCustomerIdError> {
        let digits = value.strip_prefix('C').ok_or(ParseCustomerIdError::InvalidFormat)?;
        if digits.len() != 6 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(ParseCustomerIdError::InvalidFormat);
        }
        Ok(CustomerId(value.to_string()))
    }
}
```

規則のない Primitive は、モデルで `unconstrained` と理由を宣言し、何も確かめない `of` のような関連関数で組み立てる。

## ファーストクラスコレクション

ほかの状態と並べてコレクションを持つドメインの型は、それをファーストクラスコレクションで包む。状態がそのコレクションだけの型で、コレクションへの操作と判断を持つ。`InvoiceLines` はその場で明細を加え、合計を出す。集約は `Vec` に触れない。

```rust
use super::line::{InvoiceLine, Money};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvoiceLines(Vec<InvoiceLine>);

impl InvoiceLines {
    pub fn of(lines: Vec<InvoiceLine>) -> Self {
        InvoiceLines(lines)
    }

    pub fn add(&mut self, line: InvoiceLine) {
        self.0.push(line);
    }

    pub fn total(&self) -> Money {
        let mut total = Money::zero();
        for line in &self.0 {
            line.with_amount(|amount| total.add(amount));
        }
        total
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn to_vec(&self) -> Vec<InvoiceLine> {
        self.0.clone()
    }
}
```

| 条件 | 意味・選択肢 |
|------|-------------|
| 値に業務上の規則（形式、範囲）がある | ファクトリが規則を確かめて Result を返す Domain Primitive |
| 値に業務上の規則がない | `unconstrained` と理由を宣言した Domain Primitive |
| 複数の値が規則とともに常に一緒に動く | 値オブジェクト |
| 型がほかの状態と並べてコレクションを持つ | ファーストクラスコレクションの型 |

## イベントソーシング

コマンドは規則を確かめ、宣言した replay メソッドを通して状態を変え、生んだ 1 つのイベントを返す。復元は保存済みのイベントを同じメソッドで再生するので、コマンドによる変更と再生による変更がずれない。replay メソッドは何も判断しない。

```rust
impl Invoice {
    pub fn issue(&mut self) -> Result<InvoiceIssued, IssueInvoiceError> {
        if self.issued { return Err(IssueInvoiceError::AlreadyIssued); }
        if self.lines.is_empty() { return Err(IssueInvoiceError::EmptyLines); }
        let event = InvoiceIssued::new(&self.id);
        self.apply_issued(&event);
        Ok(event)
    }

    pub fn apply_issued(&mut self, _event: &InvoiceIssued) {
        self.issued = true;
    }
}
```

写像は `apply_issued` を `event_ref: event.invoice.issued` とともに `replay_methods` に挙げる。`apply` という名前のメソッドでも、宣言されていなければ replay メソッドではない。

## ポート、ユースケース、アダプタ

リポジトリポートは集約の名前を付けた trait で、ユースケースのクレートで宣言し、ドメインのクレートには宣言しない。ユースケースはそれを trait オブジェクト（静的ディスパッチならジェネリック引数）で持ち、コマンドが変えた請求書を保存し、永続化の後に呼び出し側が公開できるようイベントを返す。

```rust
use billing_domain::invoice::Invoice;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvoiceNotFound;

pub trait InvoiceRepository {
    fn find_by_id(&self, invoice_id: &str) -> Result<Invoice, InvoiceNotFound>;
    fn store(&self, invoice_id: &str, invoice: Invoice);
}

use billing_domain::invoice::{InvoiceIssued, IssueInvoiceError};

use crate::invoice_repository::{InvoiceNotFound, InvoiceRepository};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueInvoiceFailure {
    NotFound(InvoiceNotFound),
    Rejected(IssueInvoiceError),
}

pub struct IssueInvoiceUseCase<'a> {
    invoice_repository: &'a dyn InvoiceRepository,
}

impl<'a> IssueInvoiceUseCase<'a> {
    pub fn new(invoice_repository: &'a dyn InvoiceRepository) -> Self {
        IssueInvoiceUseCase { invoice_repository }
    }

    /// Issues the invoice, stores it, and hands back the event for the caller to publish.
    pub fn execute(&self, invoice_id: &str) -> Result<InvoiceIssued, IssueInvoiceFailure> {
        let mut invoice = self.invoice_repository.find_by_id(invoice_id).map_err(IssueInvoiceFailure::NotFound)?;
        let issued = invoice.issue().map_err(IssueInvoiceFailure::Rejected)?;
        self.invoice_repository.store(invoice_id, invoice);
        Ok(issued)
    }
}
```

アダプタはポートを実装し、名前に保存媒体の接頭辞を付けてよい。集約は `restore`、顧客は `parse`、明細のコレクションは `of` で組み立て直す。

```rust
use std::cell::RefCell;
use std::collections::HashMap;

use billing_domain::customer_id::CustomerId;
use billing_domain::invoice::line::{InvoiceLine, Money};
use billing_domain::invoice::lines::InvoiceLines;
use billing_domain::invoice::Invoice;
use billing_use_case::invoice_repository::{InvoiceNotFound, InvoiceRepository};

pub struct InvoiceRecord {
    pub customer: String,
    pub amounts: Vec<i64>,
    pub issued: bool,
    pub last_add_line_command_id: Option<String>,
}

/// The invoices stored here take precedence over the records they were first read from.
pub struct InMemoryInvoiceRepository {
    records: HashMap<String, InvoiceRecord>,
    stored: RefCell<HashMap<String, Invoice>>,
}

impl InMemoryInvoiceRepository {
    pub fn new(records: HashMap<String, InvoiceRecord>) -> Self {
        InMemoryInvoiceRepository { records, stored: RefCell::new(HashMap::new()) }
    }
}

impl InvoiceRepository for InMemoryInvoiceRepository {
    fn find_by_id(&self, invoice_id: &str) -> Result<Invoice, InvoiceNotFound> {
        if let Some(stored) = self.stored.borrow().get(invoice_id) {
            return Ok(stored.clone());
        }
        let record = self.records.get(invoice_id).ok_or(InvoiceNotFound)?;
        let customer = CustomerId::parse(&record.customer).expect("corrupt invoice record: customer ID");
        let lines = InvoiceLines::of(record.amounts.iter().map(|amount| InvoiceLine::of(Money::of(*amount))).collect());
        let invoice = Invoice::restore(invoice_id, customer, lines, record.issued, record.last_add_line_command_id.clone())
            .expect("corrupt invoice record");
        Ok(invoice)
    }

    fn store(&self, invoice_id: &str, invoice: Invoice) {
        self.stored.borrow_mut().insert(invoice_id.to_string(), invoice);
    }
}
```

## モジュール配置

| 配置 | 子を持つモジュール | 葉 |
|------|-------------------|----|
| `file` | `src/invoice.rs` | `src/invoice/line.rs` |
| `mod-rs` | `src/invoice/mod.rs` | `src/invoice/line.rs` |

`lib.rs`、`main.rs`、Cargo が指定するルートは、どちらの配置でも名前を変えない。配置はすべてのパッケージ、テスト、example、bench、ビルドスクリプトに適用する。`#[cfg(test)]` のモジュールは、別ファイルでもインラインでもテストコードであり、業務コードとしては検査しない。

## ワークスペースの配置

```text
Cargo.toml
packages/
  command/
    billing-domain/            # domain（接尾辞 -domain）
    billing-use-case/          # use-case
    billing-interface-adapter/ # interface-adapter
  query/
    billing-query-use-case/
    billing-query-interface-adapter/
  rmu/
    billing-rmu/
  composition-root/
    billing-api/               # すべてを結線するバイナリ
```
