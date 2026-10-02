# DDD TypeScript 知識

## コード表現

プロジェクト設定で、すべての集約、Entity、Domain Primitive、値オブジェクトに使う表現を 1 つ選ぶ。どちらも実行時に状態を隠し、1 つの完全コンストラクタで組み立てる。違いは型の書き方にある。

| 条件 | 意味・選択肢 |
|------|-------------|
| チームが class と実行時に非公開の `#` フィールドを好む | `class`: 非公開のコンストラクタが状態全体を受け取り、静的ファクトリはそれを経由する |
| チームが素の型と関数を好む | `companion`: `type` リテラルと同名の `const` オブジェクト。ファクトリのクロージャが状態を持つ |
| 集約ごとに実行モデルや永続化が違う | この選択には関係しない。表現はプロジェクト全体で 1 つ |

以下の例では、顧客を Domain Primitive `CustomerId`、明細金額を Domain Primitive `Money`、明細をファーストクラスコレクション `InvoiceLines` で持つ。請求書 ID とコマンド ID は例を短く保つために裸の `string` のままにしている。実際のコードでは同じ作り方で包む。

`private`、`protected`、`readonly` は実行時に消える。`#` フィールドとクロージャは実行時にも非公開である。ブランドは同じ形のオブジェクトの代入を防ぐが、ファクトリが組み立てたことの証明にはならない。

### class 表現

`open` は検証して非公開のコンストラクタで組み立て、`Result` を返す。`restore` は状態全体を検証してから永続化された請求書を組み立て直し、壊れた状態では throw する。これは業務上の失敗ではない。コマンド `addLine`（`command.invoice.add-line`）と `issue` は、呼ばれた請求書を変えない。変更後の状態で非公開のコンストラクタから新しい請求書を組み立て、生んだ 1 つのイベントと一緒に、写像の `success_type` が名付ける成功値の型（`AddInvoiceLineOutcome`、`IssueInvoiceOutcome`）で返す。`addLine` は最後に反映した明細追加のコマンド ID を記憶し（モデルは `retention: last-one` を宣言する）、再送されたコマンドをほかのどの判定より先に認識する。そのときは `kind: "duplicate"` と変わらない請求書を返し、イベントは返さないので、イベントが二重に公開されない。イベント（`InvoiceLineAdded`、`InvoiceIssued`）は集約のモジュールで宣言する読み取り専用のデータ型である。`#` フィールドはすべて `readonly` にする。`total()` は明細のコレクションに合計を頼み、`lines()` は明細の複製を返す。

```ts
import type { Result } from "@acme/language-extensions";
import type { CustomerId } from "./customer-id.ts";
import type { InvoiceLine, Money } from "./invoice/line.ts";
import type { InvoiceLines } from "./invoice/lines.ts";

export type OpenInvoiceError = "negative-total";
export type AddInvoiceLineError = "already-issued" | "negative-total";
export type IssueInvoiceError = "already-issued" | "empty-lines";

export type InvoiceLineAdded = { readonly invoiceId: string; readonly commandId: string; readonly line: InvoiceLine };
export type InvoiceIssued = { readonly invoiceId: string };

export type AddInvoiceLineOutcome =
  | { readonly kind: "applied"; readonly invoice: Invoice; readonly event: InvoiceLineAdded }
  | { readonly kind: "duplicate"; readonly invoice: Invoice };
export type IssueInvoiceOutcome = { readonly invoice: Invoice; readonly event: InvoiceIssued };

export class Invoice {
  readonly #id: string;
  readonly #customer: CustomerId;
  readonly #lines: InvoiceLines;
  readonly #issued: boolean;
  readonly #lastAddLineCommandId: string | undefined;

  private constructor(
    id: string,
    customer: CustomerId,
    lines: InvoiceLines,
    issued: boolean,
    lastAddLineCommandId: string | undefined,
  ) {
    this.#id = id;
    this.#customer = customer;
    this.#lines = lines;
    this.#issued = issued;
    this.#lastAddLineCommandId = lastAddLineCommandId;
  }

  static open(id: string, customer: CustomerId, lines: InvoiceLines): Result<Invoice, OpenInvoiceError> {
    if (lines.total().isNegative()) return { ok: false, error: "negative-total" };
    return { ok: true, value: new Invoice(id, customer, lines, false, undefined) };
  }

  static restore(
    id: string,
    customer: CustomerId,
    lines: InvoiceLines,
    issued: boolean,
    lastAddLineCommandId: string | undefined,
  ): Invoice {
    if ((issued && lines.isEmpty()) || lines.total().isNegative()) throw new Error("corrupt invoice state");
    return new Invoice(id, customer, lines, issued, lastAddLineCommandId);
  }

  addLine(commandId: string, line: InvoiceLine): Result<AddInvoiceLineOutcome, AddInvoiceLineError> {
    if (commandId === this.#lastAddLineCommandId) return { ok: true, value: { kind: "duplicate", invoice: this } };
    if (this.#issued) return { ok: false, error: "already-issued" };
    const lines: InvoiceLines = this.#lines.add(line);
    if (lines.total().isNegative()) return { ok: false, error: "negative-total" };
    const invoice: Invoice = new Invoice(this.#id, this.#customer, lines, false, commandId);
    const event: InvoiceLineAdded = { invoiceId: this.#id, commandId, line };
    return { ok: true, value: { kind: "applied", invoice, event } };
  }

  issue(): Result<IssueInvoiceOutcome, IssueInvoiceError> {
    if (this.#issued) return { ok: false, error: "already-issued" };
    if (this.#lines.isEmpty()) return { ok: false, error: "empty-lines" };
    const invoice: Invoice = new Invoice(this.#id, this.#customer, this.#lines, true, this.#lastAddLineCommandId);
    const event: InvoiceIssued = { invoiceId: this.#id };
    return { ok: true, value: { invoice, event } };
  }

  isBilledTo(customer: CustomerId): boolean {
    return this.#customer.equals(customer);
  }

  total(): Money {
    return this.#lines.total();
  }

  lines(): readonly InvoiceLine[] {
    return this.#lines.toArray();
  }
}
```

### companion 表現

状態全体を受け取るファクトリ（`restore`）が完全コンストラクタである。検証し、入力を複製してクロージャの状態に入れ、型の注釈を付けたリテラルでインスタンスを書く。`open` とコマンドはそれを経由して組み立てるので、コマンドは新しいインスタンスを返し、クロージャの状態には書き込まない。読み取り専用の型はコレクション自身の変数に付け、状態のオブジェクトには注釈を付けない。

```ts
import type { Result } from "@acme/language-extensions";
import type { CustomerId } from "./customer-id.ts";
import type { InvoiceLine, Money } from "./invoice/line.ts";
import type { InvoiceLines } from "./invoice/lines.ts";

export type OpenInvoiceError = "negative-total";
export type AddInvoiceLineError = "already-issued" | "negative-total";
export type IssueInvoiceError = "already-issued" | "empty-lines";

export type InvoiceLineAdded = { readonly invoiceId: string; readonly commandId: string; readonly line: InvoiceLine };
export type InvoiceIssued = { readonly invoiceId: string };

export type AddInvoiceLineOutcome =
  | { readonly kind: "applied"; readonly invoice: Invoice; readonly event: InvoiceLineAdded }
  | { readonly kind: "duplicate"; readonly invoice: Invoice };
export type IssueInvoiceOutcome = { readonly invoice: Invoice; readonly event: InvoiceIssued };

const brand: unique symbol = Symbol("Invoice");

export type Invoice = {
  readonly [brand]: true;
  addLine(commandId: string, line: InvoiceLine): Result<AddInvoiceLineOutcome, AddInvoiceLineError>;
  issue(): Result<IssueInvoiceOutcome, IssueInvoiceError>;
  isBilledTo(customer: CustomerId): boolean;
  total(): Money;
  lines(): readonly InvoiceLine[];
};

export const Invoice = {
  open(id: string, customer: CustomerId, lines: InvoiceLines): Result<Invoice, OpenInvoiceError> {
    if (lines.total().isNegative()) return { ok: false, error: "negative-total" };
    return { ok: true, value: Invoice.restore(id, customer, lines, false, undefined) };
  },
  restore(
    id: string,
    customer: CustomerId,
    lines: InvoiceLines,
    issued: boolean,
    lastAddLineCommandId: string | undefined,
  ): Invoice {
    if ((issued && lines.isEmpty()) || lines.total().isNegative()) throw new Error("corrupt invoice state");
    const state = { id, customer, lines, issued, lastAddLineCommandId };
    const instance: Invoice = {
      [brand]: true,
      addLine(commandId: string, line: InvoiceLine): Result<AddInvoiceLineOutcome, AddInvoiceLineError> {
        if (commandId === state.lastAddLineCommandId) return { ok: true, value: { kind: "duplicate", invoice: instance } };
        if (state.issued) return { ok: false, error: "already-issued" };
        const next: InvoiceLines = state.lines.add(line);
        if (next.total().isNegative()) return { ok: false, error: "negative-total" };
        const invoice: Invoice = Invoice.restore(state.id, state.customer, next, false, commandId);
        const event: InvoiceLineAdded = { invoiceId: state.id, commandId, line };
        return { ok: true, value: { kind: "applied", invoice, event } };
      },
      issue(): Result<IssueInvoiceOutcome, IssueInvoiceError> {
        if (state.issued) return { ok: false, error: "already-issued" };
        if (state.lines.isEmpty()) return { ok: false, error: "empty-lines" };
        const invoice: Invoice = Invoice.restore(state.id, state.customer, state.lines, true, state.lastAddLineCommandId);
        const event: InvoiceIssued = { invoiceId: state.id };
        return { ok: true, value: { invoice, event } };
      },
      isBilledTo(customer: CustomerId): boolean {
        return state.customer.equals(customer);
      },
      total(): Money {
        return state.lines.total();
      },
      lines(): readonly InvoiceLine[] {
        return state.lines.toArray();
      },
    };
    return instance;
  },
};
```

## Domain Primitive

Domain Primitive は値を 1 つ包み、値の規則を持つ。モデルは規則を、その Primitive を指す不変条件と、それを組み立てるファクトリ規則として宣言する。ファクトリ（`parse`）は規則を確かめ、自分のエラー型を持つ `Result` を返すので、存在する `CustomerId` は常に正しい。等価は値で決まる（`equals`）。companion 表現では同じ形を `type`、ブランド、`const` オブジェクトで書き、`equals` は相手に値の照合を頼む。

```ts
import type { Result } from "@acme/language-extensions";

export type ParseCustomerIdError = "invalid-format";

export class CustomerId {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static parse(value: string): Result<CustomerId, ParseCustomerIdError> {
    if (!/^C[0-9]{6}$/.test(value)) return { ok: false, error: "invalid-format" };
    return { ok: true, value: new CustomerId(value) };
  }

  equals(other: CustomerId): boolean {
    return other.#value === this.#value;
  }
}
```

規則のない Primitive は、モデルで `unconstrained` と理由を宣言し、何も確かめない `of` で組み立てる。

`Money` はその例である。モデルは個々の明細金額を理由付きの `unconstrained` として宣言する。負の明細を別の明細で相殺できる一方、集約が合計の非負を守るためである。2 つの `Money` を足す `add` は、相手の `#value` を同じクラスの中で読む。`#` フィールドは同じクラスのほかのインスタンスからも読めるので、getter で値を取り出してクラスの外で足すことはない。`InvoiceLine` は金額を公開せず、受け取った合計に自分の金額を足した `Money` を返す（`addTo`）。合計も `Money` のまま受け渡し、負かどうかは `isNegative` に尋ねる。companion 表現では、`add` は相手に自分の値を足すよう頼む（`other.plus(state.value)`）。`equals` が相手に照合を頼むのと同じ形である。

```ts
export class Money {
  readonly #value: number;

  private constructor(value: number) {
    this.#value = value;
  }

  static of(value: number): Money {
    return new Money(value);
  }

  static zero(): Money {
    return new Money(0);
  }

  add(other: Money): Money {
    return new Money(this.#value + other.#value);
  }

  isNegative(): boolean {
    return this.#value < 0;
  }
}

export class InvoiceLine {
  readonly #amount: Money;

  private constructor(amount: Money) {
    this.#amount = amount;
  }

  static of(amount: Money): InvoiceLine {
    return new InvoiceLine(amount);
  }

  addTo(total: Money): Money {
    return total.add(this.#amount);
  }
}
```

## ファーストクラスコレクション

ほかの状態と並べてコレクションを持つドメインの型は、それをファーストクラスコレクションで包む。状態がそのコレクションだけの型で、コレクションへの操作と判断を持つ。`InvoiceLines` は明細を加えた新しいインスタンスを返し、合計を出す。集約は配列に触れない。

```ts
import { Money } from "./line.ts";
import type { InvoiceLine } from "./line.ts";

export class InvoiceLines {
  readonly #items: readonly InvoiceLine[];

  private constructor(items: readonly InvoiceLine[]) {
    this.#items = [...items];
  }

  static of(items: readonly InvoiceLine[]): InvoiceLines {
    return new InvoiceLines(items);
  }

  add(line: InvoiceLine): InvoiceLines {
    return new InvoiceLines([...this.#items, line]);
  }

  total(): Money {
    return this.#items.reduce((sum: Money, line: InvoiceLine) => line.addTo(sum), Money.zero());
  }

  isEmpty(): boolean {
    return this.#items.length === 0;
  }

  toArray(): readonly InvoiceLine[] {
    return [...this.#items];
  }
}
```

companion 表現では、コレクションを自分のブランドを持つ `type` と `const` オブジェクトで書く。

## Result と操作のエラー

`Result` は infrastructure の言語拡張パッケージ（たとえば `packages/infrastructure/language-extensions`、その `exports` のエントリで公開）に置く。ドメインのパッケージはそれを `dependencies` に挙げ、パッケージ名で `import type` する。

```ts
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
```

写像された各ファクトリとコマンドは、自分のエラー型を明記する。それは写像された case の文字列リテラルの union で、`error_type` の名前を持ち、集約のモジュールから export する。`IssueInvoiceError` は `"already-issued"` と `"empty-lines"` を持ち、`open` や `addLine` のものは持たない。コマンドの成功値の型は成功値の型で、`success_type` の名前を持ち、エラー型と並べて export する。写像されたファクトリの成功値は集約である。操作に結び付かないファクトリ（`restore` や値オブジェクトの `of`）は値そのものを返す。

## 所有

ファクトリやコマンドが受け取った配列やオブジェクトは複製して持ち（`[...lines]`）、状態として持つものではなく複製か読み取り専用の値を返す。`#` フィールドやクロージャでも、呼び出し側が同じ可変の値への参照を持っていれば変わってしまう。業務上の失敗は、新しいインスタンスを組み立てる前に返す。

## モジュール配置と指定子

パッケージの中では、モジュールを `.ts` 拡張子付きの相対指定子で指す。子 `invoice/line` を持つモジュール `invoice` は次のように置く。ほかの子 `invoice/lines` も `invoice/line` と同じように置く。

| 配置 | 親モジュール | 子 | エントリからの親の指し方 |
|------|-------------|----|-------------------------|
| `named-file` | `./invoice/line.ts` を指す `src/invoice.ts` | `src/invoice/line.ts` | `./invoice.ts` |
| `index-file` | `./line.ts` を指す `src/invoice/index.ts` | `src/invoice/line.ts` | `./invoice/index.ts` |

パッケージのエントリ `src/index.ts` は名前を 1 つずつ公開する。`named-file` では次のとおり。

```ts
export type { ParseCustomerIdError } from "./customer-id.ts";
export { CustomerId } from "./customer-id.ts";
export type {
  AddInvoiceLineError,
  AddInvoiceLineOutcome,
  InvoiceIssued,
  InvoiceLineAdded,
  IssueInvoiceError,
  IssueInvoiceOutcome,
  OpenInvoiceError,
} from "./invoice.ts";
export { Invoice } from "./invoice.ts";
export { InvoiceLine, Money } from "./invoice/line.ts";
export { InvoiceLines } from "./invoice/lines.ts";
```

`index-file` では次のとおり。

```ts
export type { ParseCustomerIdError } from "./customer-id.ts";
export { CustomerId } from "./customer-id.ts";
export type {
  AddInvoiceLineError,
  AddInvoiceLineOutcome,
  InvoiceIssued,
  InvoiceLineAdded,
  IssueInvoiceError,
  IssueInvoiceOutcome,
  OpenInvoiceError,
} from "./invoice/index.ts";
export { Invoice } from "./invoice/index.ts";
export { InvoiceLine } from "./invoice/line.ts";
export { InvoiceLines } from "./invoice/lines.ts";
```

モジュールのパスは集約写像の `module` の区切りに対応する。`src/index.ts` は `[]`、`src/invoice.ts` と `src/invoice/index.ts` は `[invoice]`、`src/invoice/line.ts` は `[invoice, line]`、`src/invoice/lines.ts` は `[invoice, lines]` である。

## ユースケースとインターフェイスアダプタ

リポジトリポートは `<Aggregate>Repository` という名前の `interface` で、ユースケースのパッケージに宣言し、ドメインのパッケージには宣言しない。検索は自分のエラー型を返す。

```ts
import type { Invoice } from "@acme/billing-domain";
import type { Result } from "@acme/language-extensions";

export type InvoiceNotFound = "invoice-not-found";

export interface InvoiceRepository {
  findById(invoiceId: string): Result<Invoice, InvoiceNotFound>;
  store(invoiceId: string, invoice: Invoice): void;
}
```

`execute` は ID を受け取り、集約は受け取らない。ユースケースはポートを `#` フィールドに持ち、すべての受け手に 1 つの型を明記し、集約にコマンドの実行を頼み、コマンドが返したインスタンスを保存し、永続化の後に呼び出し側が公開できるようイベントを返す。

```ts
import type { Invoice, InvoiceIssued, IssueInvoiceError, IssueInvoiceOutcome } from "@acme/billing-domain";
import type { Result } from "@acme/language-extensions";
import type { InvoiceNotFound, InvoiceRepository } from "./invoice-repository.ts";

export type IssueInvoiceFailure = InvoiceNotFound | IssueInvoiceError;

export class IssueInvoiceUseCase {
  readonly #invoiceRepository: InvoiceRepository;

  constructor(invoiceRepository: InvoiceRepository) {
    this.#invoiceRepository = invoiceRepository;
  }

  execute(invoiceId: string): Result<InvoiceIssued, IssueInvoiceFailure> {
    const found: Result<Invoice, InvoiceNotFound> = this.#invoiceRepository.findById(invoiceId);
    if (!found.ok) return found;
    const invoice: Invoice = found.value;
    const issued: Result<IssueInvoiceOutcome, IssueInvoiceError> = invoice.issue();
    if (!issued.ok) return issued;
    const outcome: IssueInvoiceOutcome = issued.value;
    this.#invoiceRepository.store(invoiceId, outcome.invoice);
    return { ok: true, value: outcome.event };
  }
}
```

アダプタはポートを実装し、名前に保存媒体の接頭辞を付けてよい。集約は `restore`、顧客は `parse`、明細のコレクションは `of` で組み立て直す。

```ts
import { CustomerId, Invoice, InvoiceLine, InvoiceLines, Money } from "@acme/billing-domain";
import type { ParseCustomerIdError } from "@acme/billing-domain";
import type { InvoiceNotFound, InvoiceRepository } from "@acme/billing-use-case";
import type { Result } from "@acme/language-extensions";

export type InvoiceRecord = {
  readonly customer: string;
  readonly amounts: readonly number[];
  readonly issued: boolean;
  readonly lastAddLineCommandId: string | undefined;
};

export class InMemoryInvoiceRepository implements InvoiceRepository {
  readonly #records: ReadonlyMap<string, InvoiceRecord>;
  readonly #stored: Map<string, Invoice>;

  constructor(records: ReadonlyMap<string, InvoiceRecord>) {
    this.#records = records;
    this.#stored = new Map();
  }

  findById(invoiceId: string): Result<Invoice, InvoiceNotFound> {
    const stored: Invoice | undefined = this.#stored.get(invoiceId);
    if (stored !== undefined) return { ok: true, value: stored };
    const record: InvoiceRecord | undefined = this.#records.get(invoiceId);
    if (record === undefined) return { ok: false, error: "invoice-not-found" };
    const customer: Result<CustomerId, ParseCustomerIdError> = CustomerId.parse(record.customer);
    if (!customer.ok) throw new Error("corrupt invoice record");
    const lines: InvoiceLines = InvoiceLines.of(record.amounts.map((amount: number) => InvoiceLine.of(Money.of(amount))));
    const invoice: Invoice = Invoice.restore(invoiceId, customer.value, lines, record.issued, record.lastAddLineCommandId);
    return { ok: true, value: invoice };
  }

  store(invoiceId: string, invoice: Invoice): void {
    this.#stored.set(invoiceId, invoice);
  }
}
```

## ワークスペースの配置

```text
tsconfig.json                  # すべてのパッケージを参照する
packages/
  infrastructure/language-extensions/   # Result
  command/billing-domain/
  command/billing-use-case/
  command/billing-interface-adapter/
  query/billing-query-use-case/
  query/billing-query-interface-adapter/
  composition-root/billing-api/
```

各パッケージは `exports` を持つ `package.json` を持ち、ソースを `src/` の下に置き、テスト、宣言ファイル、`.tsx`・`.mts`・`.cts` のソースを `src` の外に置く。参照される `tsconfig.json` はすべて `module: esnext`、`moduleResolution: bundler`、`strict: true`、es2017 から esnext までの target で揃え、どれも `baseUrl` を設定しない。
