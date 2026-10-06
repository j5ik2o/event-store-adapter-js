# 次のメジャー版（5.0.0）の設計

この文書は、event-store-adapter-js の次のメジャー版の設計案である。コードは書かない。コーディネーターがレビューし、オーナーが決めた点（第9章）を反映してから、実装に使う。

- 規範: ハブ（j5ik2o/event-store-adapter）の `docs/spec/core-contract.md`、`docs/spec/storage/dynamodb.md`、`docs/spec/storage/memory.md`、`docs/plan/implementation-plan.md`、`docs/adr/`。
- 適合テストデータ: このリポジトリの `conformance/`（v1.0.0、`conformance/README.md` が読み方）。
- 規則番号（T-1、W-8、DY-9 など）は上記の規範の番号である。この文書は規則を足さず、仕様も変えない。
- 「現行」は 4.0.x（`packages/library/package.json` の版は `4.0.2-snapshot.0`）を指す。
- 第9章には、オーナーが決めた点とその理由を残す。保留は Spanner の入口だけである。
- 「設計判断」と書いた箇所は、仕様の規則ではなく、この文書が決めた設計である。

## 1. 目的と範囲

### 1.1 目的

共通契約（封筒モデル、ADR-0001）に合わせて、ライブラリを書き直す。現行の公開 API は、集約の `version` で楽観ロックを行い、`isCreated` でイベントの種類を判断し、`asString()` を利用者の実装に任せている。新しい版は、これらを封筒・ヘッド・`seqNr` で置き換える。

### 1.2 次のメジャーの版の番号

**5.0.0**。現行は 4.0.x で、4.0.0 を出したばかりである。次は2度目のメジャーになる（指示書の前提）。移行の間の main の Snapshot は `5.0.0-snapshot.<run>.<attempt>` の形で公開する（7章）。

### 1.3 最初のメジャーに含めるもの（IP-D3、IP-D4）

| 対象 | 内容 | 主な規則 |
|:--|:--|:--|
| 中核 | 集約 ID・封筒・整数と時刻の型・シリアライザ・4つの操作・エラー分類・設定の検査 | T-1〜T-13、W-3〜W-9、R-1〜R-6、E-1〜E-3、S-1 |
| メモリ | 単一プロセスのメモリ保存先。適合も宣言する（IP-D4） | MEM-1〜MEM-13 |
| DynamoDB | 3テーブルと設定項目に作り直す | D-3〜D-9、DY-2・DY-3・DY-8〜DY-12・DY-16〜DY-19 |
| 適合テストデータの実行器 | メモリと DynamoDB の両方で全ケースを通す | 5章 |

### 1.4 外すもの

| 対象 | 扱い |
|:--|:--|
| Spanner | 最初のメジャーでは出さない。段階5で出し直す（IP-D3、IP 4.2）。恒久的な廃止ではない。現行の `EventStore.createSpanner` と `SpannerEventStoreInput`、`@google-cloud/spanner` の peer 依存、Spanner の試験・例は、削除の時点（7章）で外す。Spanner を任意の依存にするエントリポイントの分け方は9章の項目2（保留。段階5までに決める） |
| 変更フィード | 最初のメジャーに、ヘッド遷移を組み立てる関数も、再同期（DY-15）の補助も含めない（オーナーの決定、2026-10-06）。head テーブルの Streams を有効にするのはテーブル作成側（ライブラリの外）の責務である |
| TTL 方式（メモリ） | MEM-12。要求は設定エラー |
| 変更フィード（メモリ） | MEM-13。要求は設定エラー |
| 論理シャード | ADR-0006、DY-16。`ShardSelector`・`shardCount`・`ShardId` を廃止する |
| 旧データの読み込み | 旧配置の読み込みは持たない。手順書だけを用意する（8章、IP-D8） |
| 3テーブルの作成 | ライブラリの外（dynamodb.md 3.1） |

### 1.5 非目標

- 仕様や規則の変更・追加。
- 他言語（rs・java・go）の設計。
- 後方互換の層。旧 API と新 API の共存は、7章の移行期間の内部事情であり、公開しない。

## 2. 公開 API

### 2.1 前提

- 言語は TypeScript（`strict`）、ビルドは CommonJS・target es6（現行の `tsconfig` に従う）、実行は Node.js 24 以上（現行の `engines`）。
- 値は不変にする（`Readonly`、`Object.freeze`）。入力を変更しない。
- 現行のスタイル（`type` と同名の `namespace` に関数を置き、`Object.freeze` する、`index.ts` から再エクスポートする）に合わせる。
- 1つの公開型は1ファイルに置く（プロジェクトの規則）。
- ファイルの置き場所（設計判断）: 以下のファイル名（`aggregate-id.ts` など）は、最終の置き場所 `packages/library/src/` での名前である。現行の `src/` に同じ名前のファイルがあるので、旧実装の削除（7章の PR 13）まで、新しい実装は `packages/library/src/next/` に同じ名前で置く。PR 13 で、旧実装を消し、`src/next/` の中身を `src/` へ移す（7.2）。
- 失敗の返し方は、書き込み・読み取り・生成のすべての操作で `Result<T, EventStoreError>`（現行 `result.ts`）を使う（オーナーの決定、9章の項目1）。
- 名前は共通契約の `seq_nr` に合わせて `seqNr` とする。`sequenceNumber` は廃止する。

### 2.2 集約 ID（T-1・T-11・T-12）

```ts
// aggregate-id.ts
export type AggregateId = Readonly<{
  typeName: string; // T-11: "-" を含まない
  value: string;
}>;

export namespace AggregateId {
  /** T-11・T-12 を検査して作る。違反は ContractViolation（rule = "T-11" | "T-12"）。 */
  export function of(
    typeName: string,
    value: string,
  ): Result<AggregateId, EventStoreError>;

  /** T-1: `${typeName}-${value}` をライブラリが組み立てる。利用者の asString() には依存しない。T-11・T-12 を検査し、違反は ContractViolation。 */
  export function asString(id: AggregateId): Result<string, EventStoreError>;
}
```

- `asString` は、型名が `-` を含まないこと（T-11）と、型名・値・区切りの UTF-8 バイト数の合計が 1024 以下であること（T-12）を検査し、違反は `Result` の失敗で返す。文字数ではなく `Buffer.byteLength(s, "utf8")` で数える。適合データの多バイトのケースは、これで検出できる。
- 利用者が独自のオブジェクトを渡せるので、ストアの各操作も `AggregateId.asString` を通して再検査し、失敗はそのまま操作の失敗として返す。`AggregateId.of` を通っていない値でも T-11・T-12 が守られる（MEM-5 も同じ）。
- 現行の `AggregateId` の `asString: () => string` は廃止する。型名と値だけを持つ。

### 2.3 整数と時刻の型（T-9・T-13・1.5）

| 値 | 型 | 検査 |
|:--|:--|:--|
| `seqNr` | `number` | T-9: 整数で 0 以上 `Number.MAX_SAFE_INTEGER`（2^53−1）以下。範囲外は契約違反。イベントでは 0 も契約違反（W-6） |
| `occurredAt` | `Date`（T-3 が js の `Date` はミリ秒と明記している） | T-13: エポックからのナノ秒が符号付き64bitに収まる範囲。範囲外は契約違反 |

- JS の `number` は負数を表せるので、`signed_seq_nr` のケースは実行する。2^53 は `number` で正確に表せる。それを超える値は `number` で表せないので、実行器側は BigInt で読み、`Number` に変換して正確に戻らない値は「表現不能」と報告する（5.1）。
- `Date` はミリ秒精度である。T-3 は「標準時刻型の精度まで丸めてよい」としているので、ミリ秒に丸める。`representation.time_precision = milliseconds` のケースを実行し、`nanoseconds` のケースは対象外にする（理由を付けて報告する、5.1）。
- T-13 の範囲（約 1677 年〜2262 年）は `Date` の範囲より狭い。検査はミリ秒をナノ秒へ BigInt で換算して行う。`Date` の無効値（`NaN`）も契約違反（T-13）にする。

### 2.4 イベント封筒（T-2・T-3・T-4・T-5・T-13）

```ts
// event-envelope.ts
export type EventEnvelope<P = unknown> = Readonly<{
  aggregateId: AggregateId; // T-2 必須
  seqNr: number;            // T-2・T-9・W-6
  occurredAt: Date;         // T-2・T-3・T-13
  manifest: string;         // T-2: 省略時は ""。T-4: 解釈しない
  payload: P;               // T-2 必須。T-6・T-7
}>;

export type EventEnvelopeInput<P = unknown> = Readonly<{
  aggregateId: AggregateId;
  seqNr: number;
  occurredAt: Date;
  manifest?: string;
  payload: P;
}>;

export namespace EventEnvelope {
  /** T-2: 必須要素の欠落を検査し、違反は ContractViolation（rule "T-2"）。manifest を "" で埋める。T-9・T-13・W-6 を検査し、違反は ContractViolation。 */
  export function create<P>(
    input: EventEnvelopeInput<P>,
  ): Result<EventEnvelope<P>, EventStoreError>;
}
```

- T-5: 封筒は不変（`Object.freeze`）。要素を足しても、構築関数が入力オブジェクト形式なので既存の利用コードは壊れない。
- 必須要素の欠落（共通契約 T-2・T-10、P-42）: TypeScript では型が必須を表すが、型のない JavaScript から欠いて呼ばれることがある。そのため `EventEnvelope.create` と `SnapshotEnvelope.create` は実行時に検査し、契約違反（`rule: "T-2"`。スナップショットは `"T-10"`）を `Result` の失敗で返す。欠落とみなすのは、`aggregateId`・`seqNr`・`occurredAt`（スナップショットは `seqNr`）が `undefined` か `null` のとき、`payload`（スナップショットは `aggregate`）が `undefined` のときである。`payload` の JSON の `null` は値として許す。欠けたのが `seqNr` なら、メッセージに seqNr を含めない（E-3）。実装の PR 3 で、要素ごとに欠落の単体試験を書く。
- T-3: ストアは `occurredAt` をストア側の時刻で置き換えない。読み取りで同じ値（ミリ秒精度）を返す。
- `Date` は変更できる。そのため、メモリは `occurredAt` をミリ秒の数値（`getTime()`）で持ち、読み取りで返すたびに新しい `Date` を作る（MEM-6）。入力の `Date` の参照は保持しない。
- 現行の `Event` の `typeName`・`id`・`isCreated` は廃止する。ドメインのイベントは `payload` に入れる。
- `create` を通らない封筒も受け取るので、書き込みの入口で同じ検査を再度行う（W-6・T-9・T-13）。

### 2.5 スナップショット封筒（T-10）

```ts
// snapshot-envelope.ts
export type SnapshotEnvelope<S = unknown> = Readonly<{
  aggregate: S;       // T-10 必須。T-6・T-7
  seqNr: number;      // T-10・T-9
  manifest: string;   // T-10: 省略時は ""
}>;

export type SnapshotEnvelopeInput<S = unknown> = Readonly<{
  aggregate: S;
  seqNr: number;
  manifest?: string;
}>;

export namespace SnapshotEnvelope {
  /** T-10: 必須要素の欠落を検査し、違反は ContractViolation（rule "T-10"）。manifest を "" で埋める。T-9 を検査する。 */
  export function create<S>(
    input: SnapshotEnvelopeInput<S>,
  ): Result<SnapshotEnvelope<S>, EventStoreError>;
}

// latest-snapshot.ts（R-2・R-3、ADR-0002）
export type LatestSnapshot<S = unknown> = Readonly<{
  snapshot?: SnapshotEnvelope<S>; // なくてもよい（R-3）
  headSeqNr: number;              // 読み取り時点のヘッドの seqNr
}>;
```

- ヘッドの `seqNr` は封筒に含めず、`LatestSnapshot.headSeqNr` で別に返す（ADR-0002）。書き込みと読み取りは同じ `SnapshotEnvelope` 型を使う。
- 現行の `Aggregate`（`version`・`withVersion`・`updateVersion`）は廃止する。集約はドメイン側の型で、`aggregate` フィールドに入る。

### 2.6 payload とシリアライザ（T-6・T-7・T-8）

```ts
// payload-serializer.ts
export type PayloadSerializer<P> = {
  serialize(payload: P): Uint8Array;
  deserialize(bytes: Uint8Array, manifest: string): P;
};

export namespace PayloadSerializer {
  /** T-8: 既定は JSON。UTF-8 の JSON 文字列を Uint8Array にする。 */
  export function json<P = unknown>(): PayloadSerializer<P>;
}
```

- T-6: ドメイン型にライブラリの型を求めない。`P` は任意の型で、シリアライザが直列化できればよい。
- T-7: シリアライザは payload だけを扱う。メタデータ（aggregateId、seqNr、occurredAt）を埋め込まない。現行の `EventSerializer`・`SnapshotSerializer`（イベント全体・集約全体を扱い、`converter` 引数を取る）は廃止する。
- `deserialize` に `manifest` を渡すのは、複数の型の payload を1つのシリアライザで復元できるようにするためである。ライブラリは manifest を解釈しない（T-4）。ただ渡すだけである。T-4 は渡すことを禁じていないので、この形に決めた（指揮役のレビュー、2026-10-06）。
- シリアライザが投げた例外は、ライブラリが捕捉して `serialization` に分類する（`operation` は `serialize` か `deserialize`）。
- 既定 JSON は `JSON.stringify` / `JSON.parse` を使う。`undefined` や関数、`BigInt` は直列化できず、直列化の失敗になる。

### 2.7 操作（3章）と非同期の表現

```ts
// event-store.ts
export type EventStore<PE = unknown, PS = unknown> = {
  /** 3.1・H-3・W-3〜W-8 */
  persistEvent(
    event: EventEnvelope<PE>,
  ): Promise<Result<void, EventStoreError>>;

  /** 3.2・W-9: snapshot.seqNr !== event.seqNr は契約違反 */
  persistEventAndSnapshot(
    event: EventEnvelope<PE>,
    snapshot: SnapshotEnvelope<PS>,
  ): Promise<Result<void, EventStoreError>>;

  /** 3.4・R-1〜R-3・R-8。ヘッドがなければ undefined（エラーにしない） */
  getLatestSnapshotById(
    aggregateId: AggregateId,
  ): Promise<Result<LatestSnapshot<PS> | undefined, EventStoreError>>;

  /** 3.5・R-4〜R-6。seqNr 以上を昇順で全件返す */
  getEventsByIdSinceSeqNr(
    aggregateId: AggregateId,
    seqNr: number,
  ): Promise<Result<EventEnvelope<PE>[], EventStoreError>>;
};
```

- 非同期は `Promise` で表す（現行と同じ）。メモリ実装も `Promise` を返す。呼び出し側が保存先を差し替えられるようにするためである。
- 書き込みは期待値の引数を取らない。照合の期待値は `event.seqNr` から決まる（W-3・W-4・W-8）。`expectedVersion` は廃止する。
- 名前は現行の `getEventsByIdSinceSequenceNumber` から `getEventsByIdSinceSeqNr` に改める。
- 読み取りの `seqNr` 引数も T-9 で検査する。0 は T-9 では有効（0 以上の全イベントを返す）。
- 書き込みの共通規則（3.3）:

| 条件 | 結果 | 規則 |
|:--|:--|:--|
| `seqNr = 0` | 契約違反 | W-6 |
| `seqNr = 1`、ヘッドなし | 新規作成 | W-3 |
| `seqNr = 1`、ヘッドあり | 楽観ロック | W-3 |
| `seqNr ≥ 2`、`seqNr = ヘッド + 1` | 更新 | W-4・W-8 |
| `seqNr ≥ 2`、`seqNr ≤ ヘッド` | 楽観ロック | W-7・W-8 |
| `seqNr ≥ 2`、`seqNr ≥ ヘッド + 2`（ヘッドなしはヘッド 0） | 契約違反（飛び番） | W-8 |
| `snapshot.seqNr ≠ event.seqNr` | 契約違反 | W-9 |

- 保存先の違いで R-8 を明記する（メモリは原子的、DynamoDB は非原子的）。3章・4章に書く。

#### 生成関数

```ts
export namespace EventStore {
  export function createMemory<PE, PS>(
    input?: MemoryEventStoreInput<PE, PS>,
  ): Result<EventStore<PE, PS>, EventStoreError>;

  export function createDynamoDB<PE, PS>(
    input: DynamoDBEventStoreInput<PE, PS>,
  ): Promise<Result<EventStore<PE, PS>, EventStoreError>>;
}
```

- 生成の失敗も分類して返す（指示書、4.2）。メモリは同期で設定を検査する（MEM-3）。DynamoDB は設定項目の読み取り・作成が入出力なので `Promise` を返す（DY-8、P-40）。DynamoDB は生成のたびに設定項目の `BatchGetItem` が走る（4.2）。生成時の障害（`faults` の `operation = 0`）は、生成より前に実行器が登録し、生成中の SDK 要求とシリアライザの包みが消費する（5.4）。
- 現行の `createDynamoDB`・`createMemory` は同期でストアを返し、設定エラーは例外だった。置き換える。

### 2.8 エラー分類（4章）

```ts
// event-store-error.ts
export type EventStoreError =
  | { type: "optimistic-lock-conflict"; message: string; aggregateId: string; seqNr: number; headSeqNr?: number; cause?: unknown }
  | { type: "contract-violation"; rule: ContractRule; message: string; seqNr?: number; snapshotSeqNr?: number; cause?: unknown }
  | { type: "serialization-error"; operation: "serialize" | "deserialize"; message: string; cause?: unknown }
  | { type: "configuration-error"; fieldName: string; message: string; cause?: unknown }
  | { type: "storage-error"; message: string; cause?: unknown };

export type ContractRule = "T-2" | "T-9" | "T-10" | "T-11" | "T-12" | "T-13" | "W-6" | "W-8" | "W-9" | "D-7";
```

| 分類 | `type` | 主な発生 |
|:--|:--|:--|
| 楽観ロック | `optimistic-lock-conflict` | 既存集約への seq_nr=1（W-3）、seq_nr の重複（W-7）、ヘッド以下での追記（W-8）、TransactionConflict（D-6） |
| 契約違反 | `contract-violation` | W-6・W-9・T-9・T-11・T-12・T-13・W-8 の飛び番・D-7 |
| 直列化 | `serialization-error` | payload の直列化・復元の失敗 |
| 設定 | `configuration-error` | 生成時の不正な値（保持件数 0 など）、保存先に記録された設定との食い違い（P-40） |
| 保存先 | `storage-error` | 通信・保存先の失敗、読み取ったデータの欠損、設定読み取りの上限到達（DY-8） |

- E-1: 呼び出し側は `error.type` の判別（判別可能なユニオン）で分類を区別する。メッセージ文字列から分類を推測しない。現行の4分類（`optimistic-lock-conflict`・`configuration-error`・`serialization-error`・`storage-error`）の `type` 値は維持し、`contract-violation` を足す。
- E-2: 楽観ロックのメッセージに含めてよいのは、aid 文字列、追記しようとした seqNr、（分かれば）ヘッドの seqNr だけである。接続文字列・資格情報・SDK の生のエラー文は含めない。SDK の例外は `cause` に入れる。`message` には入れない。
- E-3: 契約違反のメッセージに、違反した規則番号を含める。関係する seqNr は、あるときだけ含める（T-11 の型名違反のように関係する seqNr がなければ含めない）。W-9 では `seqNr` と、異なるスナップショット番号 `snapshotSeqNr` の両方を含める。ヘッド番号は契約違反の必須値にしない。D-7 のサイズ超過は、分類 `contract-violation` だけを満たせばよい（規則番号・メッセージ条件なし）。
- 構築関数は `EventStoreError` の `namespace` に置く（現行と同じ形）:

```ts
export namespace EventStoreError {
  export function optimisticLockConflict(input: { aggregateId: string; seqNr: number; headSeqNr?: number; cause?: unknown }): EventStoreError;
  export function contractViolation(input: { rule: ContractRule; seqNr?: number; snapshotSeqNr?: number; detail?: string; cause?: unknown }): EventStoreError;
  export function serialization(operation: "serialize" | "deserialize", message: string, cause?: unknown): EventStoreError;
  export function configuration(fieldName: string, message: string, cause?: unknown): EventStoreError;
  export function storage(message: string, cause?: unknown): EventStoreError;
}
```

- `contractViolation` が `message` を組み立てる。D-7 以外では `rule` を必ず含め、`seqNr` と `snapshotSeqNr` は渡されたときだけ含める。W-9 では呼び出し側が両方を渡す。`optimisticLockConflict` が `message` を組み立てる。SDK のメッセージを受け取る引数は持たない。E-2 を構造で守る。
- 現行の `optimisticLockConflict(message?, cause?)` は、メッセージを自由に渡せる。置き換える。

### 2.9 設定（S-1・MEM-3）と保持処理の失敗通知（S-4・MEM-11）

```ts
// snapshot-retention.ts
export type SnapshotRetention = Readonly<{
  count: number; // S-1: 1 以上の整数。0・負数・小数・NaN は設定エラー
  mode?: { type: "delete" } | { type: "ttl"; graceSeconds: number }; // 既定は delete
}>;

// retention-failure.ts（S-4・MEM-11）
export type RetentionFailure = Readonly<{
  kind: "retention-failure";
  aggregateId: string;
  cause: unknown;
}>;

// memory-event-store-input.ts
export type MemoryStorage = { /* 内部の記録・設定・排他制御（不透明） */ };
export type MemoryStorageInput = Readonly<{
  retention?: SnapshotRetention;           // MEM-3: 設定は保存先が持つ。mode は delete のみ（ttl は設定エラー）
  changeFeed?: unknown;                    // 未提供の能力の要求。指定されたら設定エラー（MEM-3・MEM-13）
}>;
export namespace MemoryStorage {
  /** MEM-3: 設定を検査し、不変な設定を持つ空の独立した保存先を作る。 */
  export function create(input?: MemoryStorageInput): Result<MemoryStorage, EventStoreError>;
}

export type MemoryEventStoreInput<PE, PS> = Readonly<{
  storage?: MemoryStorage;                 // MEM-2: 同じ storage を渡したときだけ共有。省略時は新しい独立した保存先
  eventSerializer?: PayloadSerializer<PE>; // 既定は JSON
  snapshotSerializer?: PayloadSerializer<PS>;
  onRetentionFailure?: (failure: RetentionFailure) => void;
  logger?: Logger;
}>;

// dynamodb-event-store-input.ts
export type DynamoDBEventStoreInput<PE, PS> = Readonly<{
  client: DynamoDBClient;
  tables: Readonly<{ journal: string; snapshot: string; head: string }>; // DY-8
  snapshotAidIndexName: string;            // D-3: (aid, active_history_seq_nr) の疎な GSI
  eventSerializer?: PayloadSerializer<PE>;
  snapshotSerializer?: PayloadSerializer<PS>;
  retention?: SnapshotRetention;           // なし = 履歴なし（S-1）
  onRetentionFailure?: (failure: RetentionFailure) => void;
  logger?: Logger;
  retryLimit?: number;                     // DY-8: 設定照合の再要求回数の上限（初回は数えない）。既定 5（設計判断、4.2）
}>;
```

- 設定エラーになる値: `retention.count` が 1 以上の整数でない（S-1）。`graceSeconds` が 0 以上の整数でない。メモリで `mode.type = "ttl"`（MEM-3・MEM-12）。メモリで変更フィードを要求する設定（MEM-3・MEM-13）は、`MemoryStorageInput` に `changeFeed?: unknown` を持たせ、値が指定されていれば（`undefined` 以外）`MemoryStorage.create` が `configuration-error`（`fieldName = "changeFeed"`）を返す。型で項目を持たないだけでは、JavaScript からの入力を実行時に拒否できないためである。保持の設定はメモリの保存先が持つので、同じ `MemoryStorage` を共有するインスタンスは同じ設定を使う（`createMemory` は保持の設定を受け取らない）。DynamoDB で3テーブル名が空・同名、`snapshotAidIndexName` が空。保存先に記録された `store_id`・`layout_version` との食い違い（P-40）。
- 「期限切れ方式」の名前は、仕様上のもの（`retention_mode = ttl`）に対応する。型の名前は `mode.type` とした。
- S-4・MEM-11: 保持処理の失敗は書き込みの結果を変えない。`onRetentionFailure` コールバックに `RetentionFailure` を渡し、`logger.error` にも出す。コールバックが投げた例外は書き込みの結果に影響させず、`logger` に出す。公開 API の形は仕様で固定されていないので、この形は設計案である。
- 同じ最終失敗は1回だけ通知する（観察側で同じ失敗の複数ログを1つに正規化してよい、という適合データの方針に合わせる）。
- 現行の `shardCount`・`shardSelector`・`keepSnapshotCount`・`deleteTtlMillis`・`journalAidIndexName`・`snapshotActiveTtlIndexName`・`eventConverter`・`snapshotConverter` は廃止する。

### 2.10 現行の公開 API との対応表

| 現行（4.0.x） | 次（5.0.0） | 理由・規則 |
|:--|:--|:--|
| `AggregateId { typeName, value, asString }` | `AggregateId { typeName, value }` と `AggregateId.of` / `AggregateId.asString` | T-1・T-11・T-12 |
| `Aggregate`（`version`、`withVersion`、`updateVersion`、`sequenceNumber`、`id`、`typeName`） | 廃止。`SnapshotEnvelope.aggregate` にドメインの値を入れる | T-10、ADR-0002・ADR-0004 |
| `Event`（`typeName`、`id`、`aggregateId`、`sequenceNumber`、`occurredAt`、`isCreated`） | `EventEnvelope`（`aggregateId`、`seqNr`、`occurredAt`、`manifest`、`payload`） | T-2・T-3・T-5 |
| `persistEvent(event, expectedVersion)` | `persistEvent(event)` | H-2・W-3・W-4・W-8 |
| `persistEventAndSnapshot(event, aggregate)` | `persistEventAndSnapshot(event, snapshot)` | 3.2・W-9 |
| `getEventsByIdSinceSequenceNumber(id, n): Promise<E[]>`（失敗は例外） | `getEventsByIdSinceSeqNr(aid, seqNr): Promise<Result<EventEnvelope[], EventStoreError>>` | R-4〜R-6・4章 |
| `getLatestSnapshotById(id): Promise<A \| undefined>`（失敗は例外） | `getLatestSnapshotById(aid): Promise<Result<LatestSnapshot \| undefined, EventStoreError>>` | R-1〜R-3 |
| `EventSerializer`・`SnapshotSerializer`・`converter` 引数 | `PayloadSerializer` | T-6・T-7 |
| `EventStore.createDynamoDB`（同期、例外） | 非同期で `Result` を返す | DY-8・4章 |
| `EventStore.createMemory({ events, snapshots })`（`Map` の参照を共有） | `MemoryStorage.create({ retention })` で保存先を作り、`createMemory({ storage })` で明示的に共有 | MEM-2・MEM-3・MEM-6 |
| `EventStore.createSpanner` ほか Spanner 一式 | 最初のメジャーでは出さない | IP-D3 |
| `ShardSelector`・`ShardId`・`shardCount`・`DEFAULT_SHARD_COUNT` 系 | 廃止 | ADR-0006・DY-16 |
| `keepSnapshotCount`・`deleteTtlMillis` | `retention: { count, mode }` | S-1・DY-2・8章 |
| `journalAidIndexName`・`snapshotActiveTtlIndexName` | 廃止。`snapshotAidIndexName` だけ残す | D-3 |
| `EventStoreError`（4分類） | 5分類（`contract-violation` を足す）。構築関数の引数を変える | 4章・E-1〜E-3 |
| `Logger` | 維持 | S-4 |
| `Result` | 維持。全操作の戻り値に使う（9章の項目1） | — |
| 依存 `aws-sdk`（v2）・`moment`・`winston`・`@types/winston` | 外す。`src` と `packages` の TypeScript から参照がないことは確認済み | IP 4.2 |

## 3. メモリの実装方針

置き場所は、削除の時点まで `packages/library/src/next/internal/memory-event-store.ts` である（PR 13 で `src/internal/memory-event-store.ts` へ移り、現行のファイルを置き換える。2.1）。現行は集約状態の `version` で照合し、封筒とヘッドの組を返さず、イベントの参照を共有している（memory.md 8章）。全面的に置き換える。

| 規則 | 方針 |
|:--|:--|
| MEM-1 | 単一プロセスのメモリだけ。永続化しない。利用中の全消去 API は作らない |
| MEM-2 | `MemoryStorage.create()` は空の独立した記録を作る。`createMemory({ storage })` に同じ `MemoryStorage` を渡したインスタンスだけが、記録・設定・排他制御を共有する。名前の一致では共有しない。排他制御は `MemoryStorage` の内部に持つ |
| MEM-3 | `MemoryStorage.create({ retention })` が、生成時に `retention`（count 0 や ttl）を検査し、設定エラーを返す。変更フィードの要求（`changeFeed` の指定）も実行時に検査して設定エラーにする（2.9）。設定は保存先が不変（`Object.freeze`）で持つ。`createMemory` は設定を受け取らず、共有するインスタンスは保存先の設定を使う |
| MEM-4 | 排他制御は `MemoryStorage` ごとに1つ。JavaScript ではオブジェクトをスレッドをまたいで共有できない。そのため、js の保存先は1つのスレッドの中だけで共有される。同じスレッドの中で非同期の呼び出しが重なっても、確定前の途中状態を読ませないために、非同期の直列化キュー（Promise チェーンによる mutex）を使う。これが MEM-4 の満たし方である（ハブの memory.md の MEM-4 にある js の注記、2026-10-06）。スレッドをまたいで共有できる保存先は作らない（9章の項目3） |
| MEM-5 | 記録は `Map<string, 集約の記録>` で、キーは `AggregateId.asString` の完全一致。`seqNr` は別の値として扱う（連結しない）。ハッシュだけで識別せず、前方一致で選ばない。T-9・T-11・T-12・T-13 を入口で検査する。プレーンオブジェクトを辞書にしない（`"toString"` などの継承プロパティが混入するため） |
| MEM-6 | メタデータと payload を分けて持つ。payload は入力時に `serializer.serialize` で `Uint8Array` にして保持し（`Buffer` ではなくコピーを取る）、取得時に `deserialize` で復元する。利用者が書き込み後に payload を変更しても、取得結果を変更しても保存値は変わらない。T-6 を超える要件（複製可能性など）は課さない |
| MEM-7 | 排他制御の**前**に、入力検査（T-9・W-6・W-9・T-11〜T-13）と payload の直列化を終える。排他制御の**中**で、ヘッドの読み取り・照合（W-3・W-7・W-8）・変更の準備・まとめての公開（確定）・保持処理を行う。準備中の失敗は記録を変えない。イベントだけで seqNr=1 の新規作成もできる（スナップショットなし） |
| MEM-8 | `getLatestSnapshotById` は同じ排他制御の中でヘッドとスナップショットを読む。`headSeqNr` と封筒が同じ時点の値になる（R-8: 原子的） |
| MEM-9 | `getEventsByIdSinceSeqNr` は同じ排他制御の中で全件を読み、昇順で返す。復元は排他制御の外で行ってよい（直列化済みの `Uint8Array` を取り出した後） |
| MEM-10 | 保持件数がなければ現在のスナップショットだけを持つ。n ありなら新しい n 件の履歴を残し、古い順に取り除く。確定後に同じ排他制御の中で行う。イベントだけの追記でも、取り残された履歴を片付ける。ジャーナルとヘッドは取り除かない |
| MEM-11 | 保持の失敗は書き込みの成功を変えない。排他制御を解いた後に `onRetentionFailure` と `logger` で通知する。次の追記後の保持処理で再試行する（毎回、超過分を再計算するので自然に再試行になる） |
| MEM-12 | TTL 方式の要求は設定エラー |
| MEM-13 | 変更フィードを提供しない。`changeFeed` が指定されたら `MemoryStorage.create` が設定エラー（MEM-3） |

- 「確定」は、新しいヘッド・ジャーナル項目・スナップショットを組み立て終えてから、1回の代入（不変な記録の置き換え）で公開する。公開前の途中状態は誰にも見えない（H-1・MEM-4）。
- MEM-6 の `Date`: 2.4 と同じく、時刻はミリ秒の数値で記録する。
- 保持の失敗を試験で起こすために、内部にフック（保持処理の差し替え口）を持つ（5.3）。公開 API には出さない。
- 適合の事例（memory.md 9章）は、5章の実行器と、`memory-event-store.test.ts` の作り直しで確かめる。

## 4. DynamoDB の実装方針

置き場所は、削除の時点まで `packages/library/src/next/internal/dynamodb-event-store.ts` である（PR 13 で `src/internal/dynamodb-event-store.ts` へ移り、現行のファイルを置き換える。2.1）。現行は論理シャードのキー（`pkey` と `skey` の組）、ミリ秒の `occurred_at`、保持失敗を書き込み失敗にする挙動を持つ。全面的に置き換える。

### 4.1 SDK

- `@aws-sdk/client-dynamodb`（v3）。現行の `^3.413.0` で、ロックファイルは 3.1146.0 を解決している。最低版は、`ReturnValuesOnConditionCheckFailure`（D-5）と `TransactionCanceledException` の `CancellationReasons` の `Item` を型に持つ版へ上げる（実装時に、使う最小版を確認して決める。未確認）。
- `@aws-sdk/lib-dynamodb` は使わない。属性型（S/N/B/L/M）を明示し、数値は文字列の `N` で扱う（BigInt 変換のため）。
- `aws-sdk`（v2）は外す。
- 差し込みの仕組み: SDK v3 の**ミドルウェアスタック**（`client.middlewareStack.add`）を使う。5.4 で述べる。

### 4.2 3テーブルと設定項目（DY-8、P-19、P-40）

| テーブル | キー | 備考 |
|:--|:--|:--|
| journal | PK `aid`(S)、SK `seq_nr`(N) | GSI なし、Streams 無効 |
| snapshot | PK `aid`(S)、SK `skey`(N) | GSI `(aid, active_history_seq_nr)`・KEYS_ONLY（D-3）。TTL 属性 `ttl`（TTL 方式のときだけ有効、DY-2） |
| head | PK `aid`(S) | Streams 有効・NEW_IMAGE（DY-3・DY-12・D-4） |

- PK は `AggregateId.asString` そのもの（DY-16）。SK は journal が `seq_nr`、snapshot が現在 0・履歴がその seq_nr（DY-17）。
- 3テーブルは同じリージョン。読み取りは強整合（DY-18）。使う操作は aid に絞ったもの（DY-19）。`Scan` は使わない。
- 3テーブルの作成はライブラリの外。試験ではテスト側が作る（6章）。

生成時（`createDynamoDB`）の手順:

1. 生成のたびに、設定項目 `__config__` の3件（journal は `seq_nr=0`、snapshot は `skey=0`、head は SK なし）を、1回の `BatchGetItem`（`ConsistentRead=true`）で読む。
2. `UnprocessedKeys` は、そのキーだけを指数バックオフで強整合のまま再要求する。`Responses` は蓄積する。未処理がなくなるまで「存在しない」と判定しない。再要求の上限（`retryLimit`、初回を数えない）に達したら**保存先エラー**を返す（設定エラーにしない）。設計判断: 上限は回数で持ち、既定は 5 回（現行の保持処理の再試行の上限に合わせる）、バックオフの初期値は 50ms、1回の待ちの上限は 1000ms（倍々に増やす）。待つ処理は内部フック `sleep`（5.3）で差し替えられる。適合データの `dynamodb-config-retry-exhausted` は `retry_limit: 1` に未処理の応答を2回返す。1回目の再要求の後も未処理が残るので、上限到達で保存先エラーを返し、`configuration-create` の要求は送らない。
3. 3つともなければ、新しい `store_id`（ランダム値）を作り、1つの `TransactWriteItems` で `attribute_not_exists(aid)` 条件付きの `Put` を3件行う。属性は `store_id`(S) と `layout_version`(N, 1) だけ。snapshot の設定項目は `active_history_seq_nr` を持たない。条件不成立（別の実行器が先に作った）なら、応答を捨てて3件を強整合で読み直し、手順4へ。取り消し理由が `TransactionConflict`（別の実行器が書いている最中）のときも、同じく読み直す。読み直しても3つともなければ、作成を繰り返さずに保存先エラーを返す（DY-8、P-44）。
4. 3つともあり、`store_id` が3件で一致し、`layout_version` が自分の版（1）と同じなら続行する。
5. それ以外（一部のみ、`store_id` 不一致、`layout_version` 違い）は設定エラー（P-40）。
- 必要な IAM は、3テーブルへの `dynamodb:BatchGetItem` と `dynamodb:PutItem`。設定項目は条件付き `Put` だけで作る（更新・削除しない）。

### 4.3 書き込み（D-5・D-6・D-7・W-8・H-1〜H-4）

1回の書き込みは1つの `TransactWriteItems`。アクションは最大4つ:

1. journal に `Put`（条件 `attribute_not_exists(aid)`）。属性は `aid`、`seq_nr`、`occurred_at`（N、エポックナノ秒）、`manifest`(S)、`payload`(B)。
2. head: 新規作成（`seqNr = 1`）は `Put`（条件 `attribute_not_exists(aid)`）。更新は `Update`（条件 `seq_nr = :prev`、`:prev = event.seqNr − 1`。`seq_nr` と `events` を上書き）。head の `events` は要素1つの `L`（要素は `M`: `seq_nr`、`occurred_at`、`manifest`、`payload`）。`type_name`(S) も持つ。
3. スナップショットがあれば、現在のスナップショットに `Put`（`skey = 0`、条件なし）。`last_updated_at` は `occurred_at` のミリ秒。
4. 保持件数を設定していれば、履歴スナップショットに `Put`（`skey = seq_nr`、条件なし）。印のない間だけ `active_history_seq_nr` を持つ。

規則への対応:

- **D-5**: head のアクションに `ReturnValuesOnConditionCheckFailure = ALL_OLD` を付ける。`TransactionCanceledException` の `CancellationReasons` の head の要素にある旧項目の `seq_nr` を、`event.seqNr` と比べる（追加の読み取りをしない）。旧項目が返らなければヘッド 0 とみなす。
- **W-8（更新）**: 旧ヘッド `h` に対し、`event.seqNr ≤ h` は楽観ロック、`event.seqNr ≥ h + 2` は契約違反（飛び番）。ヘッドのない集約への `seqNr ≥ 2` は、ヘッド 0 とみなして飛び番の契約違反。
- **W-3**: 新規作成でヘッドの条件が不成立なら楽観ロック。
- **W-7**: journal の条件が不成立なら楽観ロック。
- **D-6**: `TransactionConflict` は楽観ロックに分類する。head 以外のスロットリングと、通信失敗・その他は保存先エラー。
- `CancellationReasons` に複数の理由があるときは、全理由を見る。どの項目の理由でも `TransactionConflict` があれば D-6（楽観ロック）にする。次に head の `ConditionalCheckFailed` を D-5 で分類し（W-3・W-8）、journal の `ConditionalCheckFailed` は W-7（楽観ロック）にする。それ以外のスロットリングは保存先エラー。この順は仕様で決まった（`dynamodb.md` 6.2、P-43。2026-10-06）。飛び番と W-7 が同時に起きる場面は適合データにない。
- **D-7**: 書き込み前に、書き込むすべての項目を見積もる。journal の項目、head の項目（`aid` と `type_name` を含む。`payload` は journal と head の両方に載る）、現在のスナップショットの項目、履歴のスナップショットの項目である。1つでも 409600 バイトを超えれば、一切送らずに契約違反（`rule: "D-7"`）にする（適合データの `no_requests_in_phases` に `commit` と `retention-*` がある）。属性名・型タグを含めた DynamoDB の項目サイズの計算規則を使う。適合データの4件（`dynamodb-item-size-event`・`-snapshot`・`-manifest`・`-head-overhead`）が、それぞれ別の項目の超過を確かめる。
- **T-3**: `occurred_at` は `BigInt(date.getTime()) * BigInt(1000000)` の10進文字列を `N` で書く。読むときは BigInt で受け取り、ミリ秒の `Date` に戻す。浮動小数点を介さない。現行の `tsconfig` は target es6 なので、BigInt リテラル（`1n`）は使わず、`BigInt()` 関数を使う。`packages/library/tsconfig.json` の `lib` は `ESNext` なので、`BigInt` の型のために `lib` を足す必要はない。
- **H-1**: 1つのトランザクションでヘッド・ジャーナル・スナップショットが確定する。変更フィードの供給源は head の Streams だけ（journal の Streams は使わない）。
- 保持処理（4.5）は、トランザクションの**確定後**に行う（D-9）。

### 4.4 読み取り（DY-9・DY-10・DY-11・R-8）

- `getLatestSnapshotById`: head の項目と、現在のスナップショット（`skey = 0`）を1回の `BatchGetItem`（強整合）で読む（DY-9）。`UnprocessedKeys` は読み切るまで再要求する。再要求は、残ったキーだけを強整合のまま指数バックオフで行い、上限と待ち時間は設定項目の読み取り（4.2）と同じ（`retryLimit`。既定 5 回。初回を数えない）にする。上限に達したら、未処理のキーを「ない」と判定せず、保存先エラーを返す（設計判断。DY-9 は上限を定めないが、上限がないと呼び出しが終わらないおそれがある）。ヘッドがなければ `undefined`、あれば封筒（なくてもよい）と `headSeqNr` の組（DY-10）。2項目の読み取りは**原子的でない**（R-8）。`TransactGetItems` は使わない（P-25）。
- `getEventsByIdSinceSeqNr`: journal に `aid = :aid AND seq_nr >= :seq_nr`、`ConsistentRead = true` で `Query` する。昇順で、`LastEvaluatedKey` が返る間は読み切る（DY-11、R-5）。
- 復元できない項目（必須属性の欠損、`payload` が `B` でない）は**保存先エラー**（読み取ったデータの欠損）にする。直列化の復元失敗は直列化エラー。

### 4.5 保持処理（8章・D-3・D-9・P-18・P-24・S-2・S-3・S-4）

履歴を書いた書き込みの**確定後**にだけ行う（D-9）。

1. 疎な GSI を `aid = :aid`、`ScanIndexForward = false` で `Query` し、読み切る（KEYS_ONLY）。
2. 今書いた履歴を加え（GSI に見えていれば重ねない）、降順の先頭 n 件を残し、それより古いものを対象にする（S-2）。
3. 削除方式: `BatchWriteItem` を25件ずつ（P-18）。`UnprocessedItems` は、残った項目だけを指数バックオフで再送する。上限と待ち時間は設定項目の読み取り（4.2）と同じ（`retryLimit`。既定 5 回。初回を数えない）にする。上限に達したら、残りを削除せずに保持の失敗として通知し、書き込みの結果は変えない。残った履歴は、次の保持処理で再び対象になる（設計判断。仕様は再送することだけを定め、上限を定めない。保持を書き込みの呼び出しの中で行うので、上限がないと呼び出しが終わらないおそれがある）。
4. TTL 方式: 1件ずつ `UpdateItem`。`SET #ttl = :expires REMOVE active_history_seq_nr`、条件 `attribute_exists(active_history_seq_nr)`。`#ttl` は `ExpressionAttributeNames`（`ttl` が予約語のため）。`:expires` は印付け時点のエポック秒＋猶予秒。後の更新が条件失敗したら、印付け済みとして読み飛ばす。
5. 件数を数えてから超過分を選ぶ方式は使わない（P-24）。印付き履歴は件数に数えず、期限は先送りしない（S-3）。
- 失敗は書き込みの結果を変えない（S-4）。`onRetentionFailure` と `logger` で通知する。現行の `dynamodb-snapshot-retention-executor.ts` の、保持失敗を書き込み失敗にする挙動は置き換える。
- 現行の `deleteTtlMillis`（ミリ秒）は、`graceSeconds`（秒、`ttl` 属性はエポック秒）に置き換える。

### 4.6 変更フィード

最初のメジャーには含めない（オーナーの決定、2026-10-06）。head の Streams を有効にするのはテーブル側で、ライブラリは DY-3・DY-12 の形（head は Streams 有効・NEW_IMAGE、journal の Streams は供給源にしない）を守って書くだけである。ヘッド遷移を組み立てる関数（DY-13）と再同期の補助（DY-15）は出さない。

## 5. 適合テストデータの実行器

### 5.0 置き場所と実行方法

- 実行器は `src/internal/test/conformance/` に置く（内部。公開しない。削除の時点までは `packages/library/src/next/internal/test/conformance/`、2.1）。ライブラリの内部モジュールとフックへ、公開 API を増やさずに触れるためである。`internal/test/` は、現行の `scripts/remove-test-artifacts.mjs` が `dist/internal/test` を消すので出荷物に入らず、`jest.config.ts` のカバレッジの除外（`!src/internal/test/**`）にも入る。PR 13 までの `src/next/internal/test/` は、この2つの設定に入らない。そのため PR 2 で、`remove-test-artifacts.mjs` の削除対象と `jest.config.ts` の除外に `next/internal/test` を加える。PR 13 で `src/internal/test/` へ移すときに、この追加分を外す。
- 実行は Jest（現行の試験基盤）から行う。1つの試験ファイル（`conformance.test.ts`）が、`conformance/` の全ファイルを読み、ケースごとに試験を動的に作る。保存先（メモリ・DynamoDB）ごとに実行する。実行器は、ライブラリの型には直接依存せず、自前の境界のインターフェイス（ストアの生成・4つの操作・封筒の構築・フック）を持つ。このインターフェイスへの対応付けは、7章の各 PR で足す。
- `conformance/` は、ハブと同一内容で写してある。実行器は `conformance/` を**書き換えない**。

### 5.1 データの読み方

| 論点 | 方針 |
|:--|:--|
| 読み込み | UTF-8 の JSON。最上位の `format` と `version` を確認する。重複キーは検出して失敗にする。標準の `JSON.parse` は重複キーを検出しないので、`manifest.py verify` が通っていることに依存し、実行器自身でも検査する案を取る（実装時に確認） |
| 任意精度整数 | `seq_nr` の `-1` や `2^53` を、汎用の JSON 値として読む。数値は `JSON.parse` の reviver の `context.source`（Node.js 24 で使えるかは未確認）か、独自の字句解析で読む。`number` へ直接変換しない。`bigint` にするのは `seq_nr` と時刻（`epoch_nanoseconds`、10進文字列から `bigint` で計算する）だけである。payload の数値は `number` のまま JSON 値として扱う。payload まで `bigint` にすると `JSON.stringify` が失敗する（`core-seq-above-max` は payload にも `9007199254740992` を持つ） |
| 型への変換 | `bigint` から `number` へは `Number(x)` で変換し、`BigInt(Number(x)) === x` で正確に戻ることを確かめる。戻らない値（2^53 を超える奇数など）はライブラリの検査に渡せないので、「表現不能」と報告する。2^53 そのもの（`Number.MAX_SAFE_INTEGER` を1つ超える値）は `number` で正確に表せるので、T-9 の上限超過として実行する。封筒の構築で T-9 の契約違反を検査し、直列化（payload の `JSON.stringify`）より先に出す。そのため payload の `9007199254740992` は直列化の失敗にならない |
| 時刻 | `occurred_at` は9桁小数秒の UTC ISO 8601 を読み、`bigint` のエポックナノ秒へ変換する |
| 精度の方針 | `precision_policy = native-time-type` の成功ケースは、入力を `Date`（ミリ秒）へ変換した値を期待値とする。実行器は変換した値と実際の値を報告する。設計判断: 変換は `BigInt` の床除算（負の無限大へ丸める）で、`BigInt` の `/` はゼロ方向への切り捨てなので、`q = ns / 1000000n` の後に `ns % 1000000n < 0n` なら `q - 1n` とする補正を入れる（`occurred-at-before-epoch` の -1 ナノ秒は -1 ミリ秒になる）。実行器の中で1つに決める。`representation.time_precision = nanoseconds` のケース（実データでは値の表に4件、場面に4件）は、対象外とし、「Date はミリ秒精度である」という理由を付けて報告する。`milliseconds` のケース（同じく4件と4件）は実行する。印のないケースは全実装が実行する |
| 負数 | `representation.signed_seq_nr = true` は実行する（`number` は負数を表せる） |
| 値の表の操作 | `buildAid` は `AggregateId.of` と `AggregateId.asString`。`user_string` は、利用者の別表現を返す試験用の ID（`asString` と `toString` が別の文字列を返す値）を `AggregateId` と同じ形で渡し、ライブラリがそれを使わずに型名と値から組み立てることを確かめる。`validateSeqNr` は `EventEnvelope.create`（`context=event`）と、値域だけを検査する内部関数（`context=value`）。`validateOccurredAt` は `EventEnvelope.create` を使って、ケースの手順（型名 `ConformanceTime`、値がケース ID）で `persistEvent` する。`fnv1a64` の4件は、最初のメジャーにハッシュを使う保存先がないので、対象外として報告する（成功にも失敗にも数えない）。段階5でハッシュを使う保存先を出すときに実行する（オーナーの決定、2026-10-06、実装計画 5 章 1） |
| payload の比較 | 既定 JSON で復元した値を、キー順・空白を無視して比較する。配列順・`null`・真偽値・文字列・数値は保つ。真偽値と数値を同一視しない。Unicode 正規化はしない |
| generators | `target`（JSON Pointer）の空文字列を、`character`（Unicode の1文字）を `byte_length`（UTF-8 総バイト数）に達するまで反復して展開する（`byte_length` ÷ 文字の UTF-8 幅 回。割り切れない指定はデータの誤りとして失敗にする）。`~0`・`~1` を復号する。Schema 検査は展開前、操作は展開後。参照実装は `tools/conformance/data.py` の `materialize` |
| サイズ | 400KB は 409600 バイト、1MB は 1048576 バイト |

### 5.2 場面の実行手順と、ストアの分離

各場面は独立したストアで実行する。手順は `conformance/README.md` に従う。

1. `backends` に実行する保存先があるか確認する。`requires = ["ttl"]` はメモリでは対象外（MEM-12。v1 の TTL 場面は DynamoDB だけ）。
2. `store` の設定からストアを生成する。`retention_count = null` は履歴なし。`retention_mode`（delete / ttl）と `ttl_grace_seconds` は `SnapshotRetention` へ対応付ける。メモリでは `MemoryStorage.create({ retention })` に渡し、`createMemory({ storage })` でストアを作る。DynamoDB は生成のたびに設定項目の `BatchGetItem` が走る（4.2）。
3. `seed.items` があれば、ストア生成の前にテスト用の権限（実行器自身のクライアント）で入れる。
4. `initialization` があれば、生成結果を検査する。生成失敗のケースは操作列がない。生成前の障害は先に登録する（`operation = 0`。登録と消費は5.4）。
5. generators を展開し、`fixtures.events`・`fixtures.snapshots` を各操作の直前に封筒として構築する。無効な入力の封筒構築中の規則違反も、その操作の失敗として捕捉する。実行器の事前検査でライブラリの検査を代替しない。
6. `steps` を配列順に、並行実行せずに実行する。
7. 各操作の `expect` と `observe` を検査する。保持失敗や遅延のある場面は、保持・検査フックの完了後に観測する。フックは書き込みの成功・失敗を変えない。
- `retry_limit` は設定照合の再要求回数の上限（初回は数えない）。`DynamoDBEventStoreInput.retryLimit` に対応付ける。指数バックオフは、時計フック（`sleep` の差し替え）で実時間を短縮してよい。

**DynamoDB のストア分離**: 場面ごとに、実行器が3テーブルと GSI を新しく作る。テーブル名は `conf-<連番>-<ランダム>-journal` のように場面ごとに一意にし、3テーブルを同じリージョンに作る。GSI 名は固定の名前でよいが、テーブルが場面ごとに別なので衝突しない。場面の終了時に3テーブルを削除する。他のケースの項目を使い回さない。作成はテスト側の `CreateTable`（現行の `dynamodb-utils.ts` を作り直す）で行う。他のケースの項目を使い回さないので、場面ごとに別のテーブルにする。DynamoDB Local での作成コスト（場面85件のうち DynamoDB は43件）が CI の制約に収まるかは、実行時間で確認する（未確認）。

**メモリのストア分離**: 場面ごとに `MemoryStorage.create()` で新しい記録を作る。

### 5.3 フックの置き場所

フックは内部の生成関数（`createDynamoDBEventStoreInternal(input, hooks)`、`createMemoryEventStoreInternal(input, hooks)`）の第2引数で渡す。公開の `EventStore.createDynamoDB` は、フックなしで内部関数を呼ぶ。

| フック | 置き場所 |
|:--|:--|
| 保持の決定的実行 | 内部フック `retentionScheduler`。通常は書き込み確定後に即時実行する。実行器は、完了を待てる実行（`await` できる `Promise`）を受け取り、`observe` の前に待つ。ライブラリ内部で保持処理を `Promise` として返す |
| 内部履歴の検査（`observe.history`） | DynamoDB: 実行器のクライアントで、その集約の snapshot テーブルの項目を `Query`（強整合）して、active（`active_history_seq_nr` あり）と marked（`ttl` あり）に分類する。現在のスナップショット（`skey = 0`）と設定項目は数えない。メモリ: 内部の論理履歴を読む内部アクセサ |
| 失敗通知の検査（`observe.notifications`） | `onRetentionFailure` の受け取りを記録する。同じ最終失敗のログが複数あれば1つに正規化する |
| SDK 要求の検査（`observe.requests`） | ミドルウェア（5.4）が、`build` 段階で組み上がった入力を記録する。式は構文解析して、式と属性名・値の束縛の構造で比較する（空白・節の順序・AND の順序は比較しない） |
| 属性検査（`observe.items`・`seed.items`） | 実行器のクライアントで `GetItem`。属性集合・型・リスト件数の検査は、除外の前の実際の項目全体で行い、属性集合を完全一致で比較する。`N` は10進文字列を整数として比較。`binary_json` は `B` の復元結果を JSON で比較。`L` の中の `M` は `nested_attributes`。`generated-store-id` の束縛は、最初の実際の `store_id` を束縛し、3項目（journal・snapshot・head の設定項目）で同じ値であることを検査する |
| 時計 | 内部フック `clock`（`() => epochSeconds`）。TTL の印付けの期限が「印付け時刻＋猶予秒」になる。v1 は2100年の時計 |
| 待ち（DY-8 のバックオフ） | 内部フック `sleep`（`(ms: number) => Promise<void>`）。既定は実時間で待つ。実行器は、待ちを記録して即座に戻る関数に差し替え、指数バックオフの実時間を短縮する（4.2） |
| 配置照合（`dynamodb/layout.json`） | 実行器が `DescribeTable` と `DescribeTimeToLive` で、作成した3テーブルを照合する。キー、GSI の射影（KEYS_ONLY）、head だけの Streams（NEW_IMAGE）、snapshot の TTL の状態も照合する。テーブル名と GSI 名は設定値に束縛する |
| SDK 要求のサイズ検査 | D-7 は、4つの項目（4.3）のどれかが超過したときに、`commit` と `retention-*` の要求が送られないことを `no_requests_in_phases` で検査する |

### 5.4 SDK の差し込みの位置

DynamoDB は、`DynamoDBClient.middlewareStack` に、実行器が追加するミドルウェアで差し込む。

- 位置（設計判断）: `build` 段階（入力が組み上がった後、署名とリトライの前）に1つに決める。SDK 要求の観測と、`replace-request`・`replace-response` の差し込みを、同じ段階のミドルウェアで行う。**自動再試行を無効**にするため、実行器が作るクライアントは `maxAttempts: 1` にする。`build` 段階で差し込めるかは、実装の最初の PR で小さな試作で確かめる（未確認）。
- `replace-request`: ミドルウェアが `next` を呼ばず、例外または応答を返す。何も確定しない。v1 の書き込み失敗と保持失敗は全てこれ。
- `replace-response`: `next` を呼んだ後に、応答を差し替える。副作用は残る。
- 保持処理の要求だけを失敗させる（IP 6）。ミドルウェアは、コマンド名と、テーブルと GSI の対象（`QueryCommand` の `IndexName`、`BatchWriteItemCommand`、`UpdateItemCommand` の対象）で対象を絞る。書き込みのトランザクションは失敗させない。
- 生成時の `TransactWriteItems`（段階 `configuration-create`）と、書き込みの `TransactWriteItems`（段階 `commit`）は、操作番号で区別する。生成は `operation = 0`、書き込みは1以上である。ミドルウェアは、実行器が今実行している操作番号を持ち、登録した障害の `operation` と段階の両方が合う要求にだけ差し込む。
- ライブラリ本体にミドルウェアを置かない。ライブラリは、渡されたクライアントをそのまま使う。

#### 障害の登録・消費・未発火の検査（共通の仕組み）

実行器が、障害の登録簿を1つ持つ。差し込み口は3つあり、どれも同じ登録簿を使う。

| 差し込み口 | 対象の段階 |
|:--|:--|
| SDK のミドルウェア（`build` 段階） | `commit`・`read-events`・`read-snapshot`・`retention-*`・`configuration-*` |
| シリアライザの包み（`PayloadSerializer` を包む関数） | `serialize-event`・`serialize-snapshot`・`deserialize-event`・`deserialize-snapshot` |
| メモリの内部フック | `commit`・`read-events`・`read-snapshot`・`retention-*` |

- 登録: 場面の `faults` を、操作番号（0 は生成）と段階ごとに、すべて登録する。異なる段階の障害は、すべて同時に登録する。生成前の障害（`operation = 0`）は、ストア生成の前に登録する。
- 消費: 同じ操作番号・同じ段階の障害は、配列順に1件ずつ消費する。差し込み口は、要求・呼び出しが来るたびに、登録簿から合う障害を探して発火する。
- `repeat`: `{ "mode": "count", "count": n }` は、n 回発火したら消費済みにする。`{ "mode": "until-operation-finishes" }` は、その操作が終わるまで発火し続け、操作の終了で消費済みにする。
- 未発火の検査: 操作の終了（生成では生成の終了）で、その操作番号の登録済みの障害が1度も発火していなければ、場面を失敗にする。`until-operation-finishes` も1度は発火している必要がある。差し込めなかった段階は、成功に数えずに「未検証」と報告する（5.5、5.8）。

### 5.5 障害の差し込み（12段階）

`phase` は12種類である（`conformance/schema/common.schema.json` の列挙。指示書の13は指揮役の誤りだった）。

| 段階 | DynamoDB | メモリ |
|:--|:--|:--|
| `serialize-event` | イベントのシリアライザをラップし、`serialize` を失敗させる | 同じ（排他制御の前に失敗するので記録は変わらない） |
| `serialize-snapshot` | スナップショットのシリアライザをラップ | 同じ |
| `deserialize-event` | イベントのシリアライザの `deserialize` を失敗させる | 同じ |
| `deserialize-snapshot` | スナップショットのシリアライザの `deserialize` を失敗させる | 同じ |
| `commit` | `TransactWriteItems` のミドルウェア。`replace-request`（`TransactionCanceledException` の組み立てを含む）と `replace-response`。`cancellation_reasons` は5.7 | 確定の直前（まとめて公開の前）の内部フックで失敗させる。ヘッド・ジャーナル・スナップショットに変更を残さない。SDK の例外はないので `sdk-error` 系は**差し込めない**（未検証と報告。代わりに、確定前の失敗で記録が変わらないことを `storage-error` のケースで確かめる） |
| `read-events` | `QueryCommand`（journal）のミドルウェア | 読み取り直前の内部フック |
| `read-snapshot` | `BatchGetItemCommand` のミドルウェア（`sdk-response` の応答計画、`read-interleave` を含む） | 読み取り直前の内部フック。`read-interleave` は R-8 が原子的なので対象外（理由を記録） |
| `retention-query` | GSI の `QueryCommand` のミドルウェア（`history_pages` の応答計画を含む） | 論理履歴の列挙フック。`history_pages` が、論理履歴の列挙を置き換える。ページ列の履歴 seq_nr を連結して返す（今書いた履歴は自動追加しない）。今書いた履歴を加えて重複を除くのは、ライブラリのコード（4.5 の手順2と同じ処理）が行う。メモリにページ送りはないので `LastEvaluatedKey` と `ExclusiveStartKey` の対応付けは行わない。保持対象の選択結果は `observe.history` で確かめる |
| `retention-delete` | `BatchWriteItemCommand`（`unprocessed_first_n` を含む） | 論理履歴の削除フック。`BatchWriteItem` の分割と `unprocessed_first_n` は存在しない（DynamoDB だけ） |
| `retention-mark` | `UpdateItemCommand`（snapshot の TTL 印付け） | TTL がないので**対象外**（MEM-12） |
| `configuration-read` | 生成時の `BatchGetItemCommand`（`unprocessed_keys`） | 設定の読み取りがないので**対象外** |
| `configuration-create` | 生成時の `TransactWriteItemsCommand`（`install_items` による生成競合を含む） | 設定の作成がないので**対象外** |

- メモリを対象に含む障害ケースは、`conformance/scenarios/core/retention-errors.json` に11件ある（`conformance/` を走査して確認した範囲）。`retention-query` の `history_pages` を指定するのは、`core-retention-delete-1`・`core-retention-delete-2`・`core-retention-failure-after-commit`・`core-retention-query-failure` の4件で、上の対応付けで差し込む。残り7件は、`core-serialize-event`（`serialize-event`）、`core-serialize-snapshot`（`serialize-snapshot`）、`core-deserialize-event`（`deserialize-event`）、`core-deserialize-snapshot`（`deserialize-snapshot`）、`core-storage-commit-failure`（`commit`）、`core-storage-read-events`（`read-events`）、`core-storage-read-snapshot`（`read-snapshot`）で、いずれも上の表のメモリ列のフックで差し込む。それ以外の段階でメモリに差し込めないものが実行対象に現れた場合は、理由つきで「未検証」と報告し、成功に集計しない。
- `kind` の扱い: `serialization-error` はシリアライザの対応段階を失敗させる。`storage-error` は保存先・保持フックの最終失敗。`details.scope = final-retention-failure` は、候補選択後・削除前に保持全体を失敗させる。フックの位置は、DynamoDB では 4.5 の手順2（対象の選択）と手順3（削除）の間、メモリでは論理履歴の削除フックの直前である。`omit_just_written_history` は DynamoDB だけにある（GSI が今書いた履歴をまだ返さない状況を作る）。メモリは対象外とする。`sdk-error` は、`details.code` と `cancellation_reasons` から SDK の例外クラス（`TransactionCanceledException` など）を組み立てる。`sdk-response` は応答計画。`read-interleave` は DY-9 の非原子的応答。
- `read-interleave`: 送信直前に旧ヘッドを捕捉し、`interleaved_operation` の追記を確定し、元の `BatchGetItem` を送って、応答内のヘッドを旧ヘッドへ差し替える。実時間の競争は使わない。実行器が別のストアインスタンスで追記を行う。
- `repeat` の扱いは、5.4 の共通の仕組みに従う。

### 5.6 `observe.requests` の検査

- 式は、実行器内の小さな構文解析で `SET`・`REMOVE`・条件式の構造に分解する。空白・節の順序・AND の順序は比較しない。
- `key_condition.all`（`eq` / `gte` と `aggregate_id`・`seq_nr` の束縛）、TTL の `#ttl` と `ExpressionAttributeNames`、`expires`（エポック秒）、`initial_batch_sizes`（再送を除く削除バッチ件数）、`no_requests_in_phases`、`request_count`、`minimum_request_count` を検査する。
- `requests` の要素は、実際の別々の要求に配列順で対応付ける。ページ送り・未処理キーの再要求・削除バッチ分割は、段階の要求列全体で検査する。

### 5.7 `cancellation_reasons`

トランザクションの各アクションに1要素。書き込みは journal・head・current-snapshot・history-snapshot の順（存在するアクションだけ）。設定作成は `configuration:journal`・`configuration:snapshot`・`configuration:head`。失敗していない要素の `Code` は文字列 `None`。実行器は、対象名を実際の要求内のアクションに照合して並べ直す（ライブラリの要求順を強制しない）。head の `ConditionalCheckFailed` は `old_head_seq_nr`（`null` は旧項目が返らない）を持つ。D-5 の分類はこの旧項目を使う。ライブラリの分類は、4.3 のとおり全理由を見る（どの項目の `TransactionConflict` も D-6）。

### 5.8 報告と CI

- 報告の形（JSON と、Jest の標準出力への要約の両方）:
  - データの版と `manifest.json` の照合結果。
  - 言語（`typescript`）、実装版（`package.json` の版）、保存先（`memory` / `dynamodb`）。
  - ケース ID と規則番号ごとの結果: `passed`（成功）/ `failed`（失敗）/ `not-applicable`（対象外）/ `unverified`（未検証）/ `not-representable`（表現不能）の5つ。ナノ秒の精度の印のケースと、`fnv1a64` の4件は、`not-applicable` と理由で報告する。`number` で表せない値は `not-representable` で報告する。
  - 失敗した操作番号と、期待値・実際の値。
  - 表現能力の違いによる選択・任意能力・削除済み規則・呼び出し側の推奨の理由。
- 1ケースが複数の規則を持てば、全規則へ対応付ける。途中で期待と異なれば成功と報告しない（IP 5）。条件を満たさないケース、必須ケースを飛ばした結果、障害を差し込めなかった結果を成功に集計しない。
- 結果の表現名は、`conformance/README.md` の語に合わせる。語が異なれば README を優先する（実装時に確認）。
- 配布の検証: 現行 CI の `release-checks` に既にある `python3 tools/conformance/manifest.py verify` と、`manifest.json` の SHA-256（v1.0.0 は `61c26614dbbfba88eebce72cc1d2b0220218839e74dcfb64c19268f7ee2302ce`）の照合を、維持する。manifest を作り直して差分を隠さない。`conformance/.gitattributes` が改行変換を止めている。
- 実行: `pnpm --filter event-store-adapter-js run coverage --runInBand`（現行の `test` ジョブ）に含める。DynamoDB Local はテスト内で Testcontainers が起動する（6章）。実行時間が長ければ、専用ジョブに分ける。

## 6. 試験環境

### 6.1 DynamoDB Local 3.3.1

- イメージ: `amazon/dynamodb-local` を、digest `sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab`（3.3.1、2026-10-05 に固定）で指定する。
- 起動方法: 現行の Testcontainers（`GenericContainer`、現行の `packages/examples/src/dynamodb-container.ts` と `packages/library/src/internal/test/dynamodb-utils.ts` の形）を使う。イメージ指定は `amazon/dynamodb-local@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab` とする。
- ポートは 8000。待ち受けの確認は、ポートの待ち受けを待つ方式（`Wait.forListeningPorts()`）を使う（ログの文言には依存しない）。
- 起動のオプション: メモリ上の実行（`-inMemory`）、共有データベース（`-sharedDb`）は、場面ごとにテーブルを分けるので不要。リージョンとアクセスキーは固定のダミー値（試験専用）。
- クライアントには `endpoint` を**明示**する。Streams のクライアントにも同じ `endpoint` を明示する。Streams の ARN のリージョンは `ddblocal` で、ARN から推測してはならない（hub の `docs/plan/implementation-plan.md` 4.1）。
- DynamoDB Local での TTL の扱い（実際の期限切れ削除は行われない可能性）は、TTL の期限の検査を属性の値（`ttl` のエポック秒）で行うので影響しない。TTL の有効化（`UpdateTimeToLive`）が受け付けられ、`DescribeTimeToLive` で読めるかは、`dynamodb/layout.json` の照合で確かめる（未確認）。

### 6.2 今の試験（LocalStack）からの移し方

| 対象 | 現状 | 移し方 |
|:--|:--|:--|
| `packages/library/src/internal/dynamodb-event-store.test.ts` | LocalStack（`localstack/localstack:2.1.0`、ポート 4566） | 旧実装の削除（PR 13）まで、LocalStack のまま残す。新しい DynamoDB 実装の試験は、`src/next/` に新しく作り、DynamoDB Local で動かす。PR 13 で旧試験を消す |
| `packages/library/src/internal/test/dynamodb-utils.ts` | 旧配置（journal と snapshot、`pkey` など）の `CreateTable` | 旧実装の削除まで残す。新配置（3テーブルと GSI）の `CreateTable` は、`src/next/internal/test/` に新しく作る。ポートは 8000 |
| `packages/library/src/internal/test/user-account-repository.test.ts` | LocalStack | 旧実装の削除（PR 13）まで残す。新 API の同等の試験は `src/next/` に新しく作り、DynamoDB Local で動かす |
| `packages/examples/src/dynamodb-container.ts` | LocalStack | 利用側を移す PR 12 で、DynamoDB Local と新 API に移す |
| `packages/examples/README.md` | LocalStack の説明 | 文書の更新は段階の最後（5.0.0 の文書の PR）。今回は触れない |
| 依存 `testcontainers` | `^12.0.0` | 維持 |

- LocalStack を扱う期間（設計判断）: 旧実装の試験（LocalStack）は、旧実装の削除（PR 13）まで消えない。新実装の試験（DynamoDB Local）は PR 9 から加わる。PR 9〜PR 12 の間、CI には LocalStack と DynamoDB Local の両方が残る。PR 12 で `examples` と `packages/tests` が DynamoDB Local に移り、PR 13 で LocalStack の依存が消える。

## 7. main への入れ方

### 7.1 方針

実装計画 3 章の進め方に従う。main に PR ごとに squash マージする。main の Snapshot は次のメジャーの版（`5.0.0-snapshot.*`）で公開する。メジャーの公開は、受け入れ条件（IP 5）を満たした後、オーナーの承認を得て手動で出す。worker は PR の作成までで、マージはコーディネーターが行う（IP 9）。

### 7.2 各 PR で main の CI を通し続ける方法

現行の CI は、`lint`・`test`（ビルドと coverage）・`examples`（`pnpm run test:examples`）・`package-tests`（`pnpm run test:packages`）・`release-checks` と、集約の `ci-success` からなる。各 PR は、これらすべてを通す。

- `examples` と `package-tests` は、公開 API を使う。PR 12 までは旧 API のまま通る。PR 12 で新 API に移す。`packages/tests` は `workspace:*` でワークスペースのライブラリに依存し、公開した版には依存しない。
- 新旧の置き場所（設計判断）: 新しい中核・メモリ・DynamoDB は `packages/library/src/next/` に、最終の名前と同じファイル名で作る（2.1）。現行の `src/` のファイルと名前が衝突しない。PR 12 までは、`index.ts` から `src/next/` を公開しない。`src/next/` は内部の試験だけで検証する。PR 12 で `index.ts` を `src/next/` に向け替える。PR 13 で旧実装を消し、`src/next/` の中身を `src/` へ移す。
- 旧 API と新 API の**公開上の共存はしない**。共存は、PR 1〜PR 11 の間の、内部の作業中の状態である。
- 新しい試験は、DynamoDB Local で動く。CI の Docker の実行が必要（現行の LocalStack と同じ前提）。

### 7.3 PR の列

1つの PR は、1つの規則群に対応させる。

| PR | 範囲 | 対応する規則群 | 備考 |
|:--|:--|:--|:--|
| PR 1: 下準備 | `packages/library/package.json` の版を `5.0.0-snapshot.0` にする（Snapshot の公開が、`snapshot.yml` の `replace(/-snapshot\.\d+$/, "")` により `5.0.0-snapshot.<run>.<attempt>` になる）。使っていない依存（`aws-sdk`・`moment`・`winston`・`@types/winston`）を外し、`pnpm-lock.yaml` を更新する | なし（IP-D1、IP 4.2） | コードの挙動は変えない。版上げの workflow（`bump-version.yml`）は手動の起動（`workflow_dispatch`）だけで、`level` に `major` があることを確かめ済み。4.x の保守（保守ブランチ、CI の対象、版上げの対応、`--tag`）は、実装計画 3 章のとおり、必要になった時点で行う |
| PR 2: 適合の実行器の基盤 | データの読み込み、場面の実行、報告、`manifest` の照合、フックの置き場所（`src/next/internal/test/conformance/`）。`remove-test-artifacts.mjs` と `jest.config.ts` の除外を `next/internal/test` に広げる（5.0）。実行器は、自前の境界のインターフェイス（5.0）だけに依存し、中核の型に依存しない。実行器の単体試験 | 5.1・5.2・5.8、IP 5 の1 | 実装計画 4.2 の順（実行器 → 中核）を保つ。各ケースの実行は、メモリ（PR 8）・DynamoDB（PR 9〜11）で有効にする |
| PR 3: 中核（値の型） | 集約 ID、イベント封筒、スナップショット封筒、整数・時刻の型 | T-1〜T-5、T-9〜T-13 | `index.ts` から公開しない |
| PR 4: 中核（payload とエラー） | `PayloadSerializer`、`EventStoreError`（5分類）と構築関数 | T-6〜T-8、E-1〜E-3 | |
| PR 5: 中核（操作） | `EventStore` の型と、書き込み・読み取りの入口の検査 | W-3〜W-9 の入口の検査、R-1〜R-6 | 保存先の照合は各保存先の PR |
| PR 6: 中核（設定） | `SnapshotRetention`、`RetentionFailure`、入力の型と検査 | S-1・S-4（型） | |
| PR 7: メモリの実装 | 新しいメモリ実装（`MemoryStorage`、排他制御、保持処理）と、その単体試験 | MEM-1〜MEM-13、R-8 | |
| PR 8: メモリの実行器のフック | 実行器のメモリ用のフック（保持の決定的実行、内部履歴、障害の差し込み）。メモリの全ケースを有効にして通す。現行の `memory-event-store.test.ts` に代わる試験 | MEM の適合の事例、IP 5 の1（メモリ） | |
| PR 9: DynamoDB の基盤 | 3テーブルの作成（試験側）、DynamoDB Local への移行（6章）、設定項目（DY-8）、配置照合（`layout.json`） | DY-2・DY-3・DY-8・DY-16〜DY-19、P-19・P-40、IP 5 の2 | |
| PR 10: DynamoDB の書き込み・読み取りと失敗の分類 | 書き込み、読み取り、D-5・D-6・D-7、`item-shapes.json` の照合 | D-4〜D-7、DY-9〜DY-11、W-3〜W-9、R-1〜R-8、P-25 | |
| PR 11: DynamoDB の保持と障害の差し込み | 保持処理（削除方式・TTL 方式）、実行器の SDK ミドルウェアと障害の差し込み | D-3・D-9、P-18・P-24、S-2〜S-4、IP 5 の1（DynamoDB） | |
| PR 12: 移行 | `index.ts` を `src/next/` に向け替える。`examples` と `packages/tests` を新 API に移す（LocalStack から DynamoDB Local へ） | IP 5 の3 | 旧実装はまだ消さない（公開はしない） |
| PR 13: 旧実装の削除 | 旧 API・旧実装（`shard-*`、`default-serializer`、旧 `dynamodb-*`、旧 `memory-*`、Spanner 一式、LocalStack の試験と依存）を消し、`src/next/` を `src/` へ移す | 削除の時点 | `package-tests` と `examples` が新 API で通る |
| PR 14: 文書 | README（英語・日本語）、スキーマの文書、移行ガイドを新契約に合わせる（IP 5 の5・6）。8章の手順書 | IP-D8 | |
| 公開 | オーナーの承認後に、手動で 5.0.0 を出す（実装計画 3 章） | IP 5 | |

- PR 13 で Spanner のコードを外すと、`@google-cloud/spanner` の peer 依存・devDependencies も外れる。段階5で出し直すときに戻す。

## 8. 移行の案内

### 8.1 対象

現行メジャー（4.x）の利用者向けの案内。実装計画 7 章（IP-D8）に従い、js の旧配置の DynamoDB には**移行ツールを提供せず、手順書だけを用意する**。手順書は PR 14 で作る。今回は骨子だけ書く。

### 8.2 旧配置の特徴

- メタデータを埋め込んだペイロード（現行の `default-serializer.ts` は、イベント全体を直列化する）。
- 利用者の `asString()` に頼る aid。
- ミリ秒の時刻。
- 論理シャード付きのキー（`pkey`・`skey`）。
- 失われた精度や型の情報を、推測で補わない。

### 8.3 利用者向けの手順の骨子

1. 旧版（4.x）のアプリケーションを止めるか、書き込みを止める時間を決める。
2. 新しい3テーブル（journal・snapshot・head）と GSI を新しい名前で作る。旧テーブルは残す。
3. 旧 API（4.x）で、集約ごとにイベントとスナップショットを読む。
4. 利用者のコードで、旧イベントから `EventEnvelope`（`aggregateId`・`seqNr`・`occurredAt`・`manifest`・`payload`）を作る。`manifest` の付け方、`payload` の形（旧のメタデータ埋め込みを外す）は、利用者が決める。
5. 新 API（5.x）で、`seqNr` の昇順に `persistEvent` で書く。スナップショットは `persistEventAndSnapshot` か、最後のイベントと一緒に書く。
6. 件数・最後の `seqNr` を旧と新で照合する。
7. 新版（5.x）に切り替える。旧テーブルは、確認後に利用者が削除する。
- 新旧で同じライブラリを同時に使えない（同じパッケージ名の別メジャー）ので、旧 API で読むための 4.x と、新 API の 5.x を別のプロセスか、`npm:` の別名で入れる方法を案内する（実装時に動作を確かめる。未確認）。

### 8.4 API の移行表

2.10 の対応表を、利用者向けに書き直して載せる。`Aggregate` の `version` を使っていた利用者は、`seqNr` へ移す。`expectedVersion` は不要になる。`isCreated` は不要になる。

## 9. 判断が要る点

オーナーが決めた点（2026-10-06）と、その理由を残す。保留は項目2だけである。設計の途中で決まった点（変更フィード、`occurredAt` の型、`deserialize` の `manifest`、実行器の置き場所、`fnv1a64`）は、本文で確定したので、この章から外した。

### 項目1: 失敗の返し方（決定）

**決定**: 書き込み・読み取り・生成のすべての操作で、失敗を `Result<T, EventStoreError>` の値として返す（選択肢 A）。

| 選択肢 | 利点 | 欠点 |
|:--|:--|:--|
| A: 全操作を `Result` で返す（採用） | 失敗が型に出る。`type` で分類を網羅的に分岐できる（E-1）。現行の書き込みと揃う | 現行の読み取りの利用者は、例外から `Result` への書き換えが要る |
| B: 全操作を例外で返す | JS の慣習に近い | 失敗が型に出ない。現行の書き込みの利用者が書き換え |
| C: 書き込みは `Result`、読み取りと生成は例外 | 利用者の書き換えが最小 | 判別の形が2系統になる。「読み取りと生成の失敗も分類して返す」を弱める |
| D: 書き込みと読み取りは `Result`、生成は例外 | 生成が簡潔 | 生成の失敗にも分類が要り、2系統になる |

- 理由: 失敗の分類を型で判別でき（E-1）、現行の書き込みの形を保てる。5.0.0 は破壊的変更なので、読み取りの書き換えは許容できる（実装計画 5 章の「決めたこと（2026-10-06）」）。

### 項目2: Spanner を任意の依存にするエントリポイントの分け方（保留）

段階5で Spanner を出し直すまでに決めればよいので、今回は決めない。案だけを残す。

| 選択肢 | 利点 | 欠点 |
|:--|:--|:--|
| A: サブパスのエクスポート（`event-store-adapter-js/spanner`） | 利用者は Spanner を使うときだけ import する。1パッケージのまま | `exports` の設定が要る。古い `moduleResolution` の利用者が型を見つけにくい。`typesVersions` の併用が要る可能性 |
| B: 別パッケージ（`event-store-adapter-js-spanner`） | 依存が完全に分かれる | モノレポのパッケージとリリースの仕組みが増える |
| C: 現行のまま、メインの入口から出し、peer を任意にする | 変更が最小 | Spanner を入れていない利用者の型検査が壊れる（`skipLibCheck` に依存する） |

- 推奨: A（保留中の暫定の見立て）。最初のメジャー（5.0.0）には Spanner のコードを出さないので、影響しない。中核の型は Spanner を参照しない。

### 項目3: メモリと複数スレッド（MEM-4）（決定）

**決定**: ハブの memory.md の MEM-4 に、オーナーが js の注記を足した（2026-10-06）。JavaScript ではオブジェクトをスレッドをまたいで共有できないので、js の保存先は1つのスレッドの中だけで共有される。同じスレッドの中で非同期の呼び出しが重なっても、確定前の途中状態を読ませないことで MEM-4 を満たす。スレッドをまたいで共有できる保存先は作らない。

| 選択肢 | 利点 | 欠点 |
|:--|:--|:--|
| A: 同じスレッド内の非同期の重なりを保護する（採用。注記に沿う） | 実装が単純。JS の通常の利用に合う | スレッドをまたぐ共有はない |
| B: `SharedArrayBuffer` と `Atomics` で、スレッドをまたいで共有する | スレッドをまたぐ共有ができる | 記録の表現と領域の管理が複雑。注記が作らないと定めている |

- 理由: 仕様の注記が A を定めている。「同じスレッドだけと読み替える」のではなく、注記に沿って満たす。

## 10. 未解決の疑問

仕様の読み方が分からない点、仕様と食い違うように見える点。仕様を勝手に解釈して埋めない。指揮役の回答（2026-10-06）と、2026-10-06 の仕様の決定（P-42〜P-45）で解けた疑問は、本文へ移した。残るのは、実装のときに確かめる次の 3 つである。

1. **ミドルウェアの差し込みの段階**: `build` 段階で `maxAttempts: 1` と `replace-request`・`replace-response` を実現できるかは、SDK の版で挙動が変わりうる。実装の最初の PR で、小さな試作で確かめる（5.4）。
2. **DynamoDB Local 3.3.1 の挙動**: ハブの `tools/spikes/dynamodb-emulators/README.md` に、`ReturnValuesOnConditionCheckFailure = ALL_OLD`、Streams の NEW_IMAGE、強整合の `BatchGetItem`、疎な GSI、TTL の有効化の確認の記録がある。期限切れの削除と `UnprocessedKeys` の発生は調べていない記録である。
3. **範囲の端の `Date` と T-13**: ミリ秒の `Date` を、ナノ秒の符号付き64bitの範囲で検査する（2.3）。範囲の端（約 1677 年・2262 年）の適合データ（`occurred-at-min`・`occurred-at-max`・`below-min`・`above-max`）で、ミリ秒の丸めの向きにより判定が変わる値があるか。実行器で値を変換して確かめる（未確認）。

解けた疑問:

- 適合データの精度の印の件数: 指揮役のレビューの件数（ミリ秒用の4件）が誤りで、実データの件数（ナノ秒・ミリ秒とも8件）が正しい（5.1）。
- 公開 API の段階的な変更: PR 12 で `index.ts` を一度に切り替える案は、実装計画 3 章と矛盾しない（指揮役の回答、2026-10-06。7.2・7.3）。
- 必須要素の欠落（T-2・T-10）の分類: 契約違反にする（共通契約 T-2・T-10、P-42）。`EventEnvelope.create`・`SnapshotEnvelope.create` が実行時に検査する（2.4）。
