# 次のメジャー版（5.0.0）の設計

この文書は、event-store-adapter-js の次のメジャー版の設計案である。コードは書かない。コーディネーターがレビューし、第9章の判断事項をオーナーが決めてから、実装に使う。

- 規範: ハブ（j5ik2o/event-store-adapter）の `docs/spec/core-contract.md`、`docs/spec/storage/dynamodb.md`、`docs/spec/storage/memory.md`、`docs/plan/implementation-plan.md`、`docs/adr/`。
- 適合テストデータ: このリポジトリの `conformance/`（v1.0.0、`conformance/README.md` が読み方）。
- 規則番号（T-1、W-8、DY-9 など）は上記の規範の番号である。この文書は規則を足さず、仕様も変えない。
- 「現行」は 4.0.x（`packages/library/package.json` の版は `4.0.2-snapshot.0`）を指す。
- 第9章の判断が出るまでは、型の形は**仮置き**である。仮置きの箇所には「仮置き」と書き、対応する9章の項目番号を示す。

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
| DynamoDB | 3テーブルと設定項目に作り直す | D-3〜D-9、DY-1〜DY-19 |
| 適合テストデータの実行器 | メモリと DynamoDB の両方で全ケースを通す | 5章 |

### 1.4 外すもの

| 対象 | 扱い |
|:--|:--|
| Spanner | 最初のメジャーでは出さない。段階5で出し直す（IP-D3、IP 4.2）。恒久的な廃止ではない。現行の `EventStore.createSpanner` と `SpannerEventStoreInput`、`@google-cloud/spanner` の peer 依存、Spanner の試験・例は、削除の時点（7章）で外す。Spanner を任意の依存にするエントリポイントの分け方は9章の項目2 |
| 変更フィード | head テーブルの Streams を有効にするのはテーブル作成側（ライブラリの外）の責務である。ヘッド遷移を組み立てる関数と DY-15 の補助を含めるかは9章の項目3 |
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
- 失敗の返し方は `Result<T, EventStoreError>`（現行 `result.ts`）を**仮置き**で使う。例外にする案との差は9章の項目1。
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

  /** T-1: `${typeName}-${value}` をライブラリが組み立てる。利用者の asString() には依存しない。 */
  export function asString(id: AggregateId): string;
}
```

- `asString` は型名・値・区切りの UTF-8 バイト数の合計が 1024 以下かを検査する（T-12）。文字数ではなく `Buffer.byteLength(s, "utf8")` で数える。適合データの多バイトのケースは、これで検出できる。
- 利用者が独自のオブジェクトを渡せるので、ストアの各操作も `AggregateId.asString` を通して再検査する。`AggregateId.of` を通っていない値でも T-11・T-12 が守られる（MEM-5 も同じ）。
- 現行の `AggregateId` の `asString: () => string` は廃止する。型名と値だけを持つ。

### 2.3 整数と時刻の型（T-9・T-13・1.5）

| 値 | 型 | 検査 |
|:--|:--|:--|
| `seqNr` | `number` | T-9: 整数で 0 以上 `Number.MAX_SAFE_INTEGER`（2^53−1）以下。範囲外は契約違反。イベントでは 0 も契約違反（W-6） |
| `occurredAt` | `Date`（仮置き。9章の項目4） | T-13: エポックからのナノ秒が符号付き64bitに収まる範囲。範囲外は契約違反 |

- JS の `number` は負数を表せるので、`signed_seq_nr` のケースは実行する。2^53 は `number` で正確に表せる。それを超える値は `number` で表せないので、実行器側は BigInt で読み、`Number` に変換して正確に戻らない値は「表現不能」と報告する（5.1）。
- `Date` はミリ秒精度である。T-3 は「標準時刻型の精度まで丸めてよい」としているので、ミリ秒に丸める。`representation.time_precision = milliseconds` のケースを実行し、`nanoseconds` のケースは対象外にする。この方針の是非が9章の項目4。
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
  /** T-2: manifest を "" で埋める。T-9・T-13・W-6 を検査し、違反は ContractViolation。 */
  export function create<P>(
    input: EventEnvelopeInput<P>,
  ): Result<EventEnvelope<P>, EventStoreError>;
}
```

- T-5: 封筒は不変（`Object.freeze`）。要素を足しても、構築関数が入力オブジェクト形式なので既存の利用コードは壊れない。
- T-3: ストアは `occurredAt` をストア側の時刻で置き換えない。読み取りで同じ値（ミリ秒精度）を返す。
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
- `deserialize` に `manifest` を渡すのは、複数の型の payload を1つのシリアライザで復元できるようにするためである。ライブラリは manifest を解釈しない（T-4）。ただ渡すだけである。この引数を持たせるかは9章の項目6で確認する。
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

- 生成の失敗も分類して返す（指示書、4.2）。メモリは同期で設定を検査する（MEM-3）。DynamoDB は設定項目の読み取り・作成が入出力なので `Promise` を返す（DY-8、P-40）。
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

export type ContractRule = "T-9" | "T-11" | "T-12" | "T-13" | "W-6" | "W-8" | "W-9" | "D-7";
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
- E-3: 契約違反のメッセージに違反した規則番号と関係する seqNr を含める。W-9 では `seqNr` と `snapshotSeqNr` の両方を含める。ヘッド番号は契約違反の必須値にしない。D-7 のサイズ超過は `contract-violation` だけを満たせばよい（規則番号・メッセージ条件なし）。
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

- `contractViolation` が `message` を組み立てる。`rule` と seqNr を必ず含める。`optimisticLockConflict` が `message` を組み立てる。SDK のメッセージを受け取る引数は持たない。E-2 を構造で守る。
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
export type MemoryStorage = { /* 内部の記録（不透明） */ };
export namespace MemoryStorage { export function create(): MemoryStorage; }

export type MemoryEventStoreInput<PE, PS> = Readonly<{
  storage?: MemoryStorage;                 // MEM-2: 同じ storage を渡したときだけ共有
  eventSerializer?: PayloadSerializer<PE>; // 既定は JSON
  snapshotSerializer?: PayloadSerializer<PS>;
  retention?: SnapshotRetention;           // mode は delete のみ（ttl は設定エラー）
  changeFeed?: unknown;                    // 未提供の能力の要求。指定されたら設定エラー（MEM-3・MEM-13）
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
  retryLimit?: number;                     // DY-8: 設定照合の再要求回数の上限（初回は数えない）
}>;
```

- 設定エラーになる値: `retention.count` が 1 以上の整数でない（S-1）。`graceSeconds` が 0 以上の整数でない。メモリで `mode.type = "ttl"`（MEM-3・MEM-12）。メモリで変更フィードを要求する設定（MEM-3・MEM-13）は、入力に `changeFeed?: unknown` を持たせ、値が指定されていれば（`undefined` 以外）生成時に `configuration-error`（`fieldName = "changeFeed"`）を返す。型で項目を持たないだけでは、JavaScript からの入力を実行時に拒否できないためである。DynamoDB で3テーブル名が空・同名、`snapshotAidIndexName` が空。保存先に記録された `store_id`・`layout_version` との食い違い（P-40）。
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
| `EventStore.createMemory({ events, snapshots })`（`Map` の参照を共有） | `MemoryStorage` を明示的に共有 | MEM-2・MEM-6 |
| `EventStore.createSpanner` ほか Spanner 一式 | 最初のメジャーでは出さない | IP-D3 |
| `ShardSelector`・`ShardId`・`shardCount`・`DEFAULT_SHARD_COUNT` 系 | 廃止 | ADR-0006・DY-16 |
| `keepSnapshotCount`・`deleteTtlMillis` | `retention: { count, mode }` | S-1・DY-2・8章 |
| `journalAidIndexName`・`snapshotActiveTtlIndexName` | 廃止。`snapshotAidIndexName` だけ残す | D-3 |
| `EventStoreError`（4分類） | 5分類（`contract-violation` を足す）。構築関数の引数を変える | 4章・E-1〜E-3 |
| `Logger` | 維持 | S-4 |
| `Result` | 維持（9章の項目1の結果による） | — |
| 依存 `aws-sdk`（v2）・`moment`・`winston`・`@types/winston` | 外す。`src` と `packages` の TypeScript から参照がないことは確認済み | IP 4.2 |

## 3. メモリの実装方針

置き場所は `packages/library/src/internal/memory-event-store.ts` を作り直す。現行は集約状態の `version` で照合し、封筒とヘッドの組を返さず、イベントの参照を共有している（memory.md 8章）。全面的に置き換える。

| 規則 | 方針 |
|:--|:--|
| MEM-1 | 単一プロセスのメモリだけ。永続化しない。利用中の全消去 API は作らない |
| MEM-2 | `MemoryStorage.create()` は空の独立した記録を作る。`createMemory({ storage })` に同じ `MemoryStorage` を渡したインスタンスだけが、記録・設定・排他制御を共有する。名前の一致では共有しない。排他制御は `MemoryStorage` の内部に持つ |
| MEM-3 | 生成時に `retention`（count 0 や ttl）を検査し、設定エラーを返す。変更フィードの要求（`changeFeed` の指定）も実行時に検査して設定エラーにする（2.9）。設定は生成後に変えられない（`Object.freeze`） |
| MEM-4 | 排他制御は `MemoryStorage` ごとに1つ。JS はシングルスレッドだが、`await` をまたぐ途中状態があるので、非同期の直列化キュー（Promise チェーンによる mutex）を使う。複数スレッド（`worker_threads`）からの利用は、通常のオブジェクトを共有できないため、同じ MEM-4 の保護を満たす方式（`SharedArrayBuffer` と `Atomics` による排他制御と、スレッド間で共有できる記録の表現）が別に要る。方式は9章の項目8。この文書は同一スレッドへの限定を確定していない。10章の項目3 |
| MEM-5 | 記録は `Map<string, 集約の記録>` で、キーは `AggregateId.asString` の完全一致。`seqNr` は別の値として扱う（連結しない）。ハッシュだけで識別せず、前方一致で選ばない。T-9・T-11・T-12・T-13 を入口で検査する。プレーンオブジェクトを辞書にしない（`"toString"` などの継承プロパティが混入するため） |
| MEM-6 | メタデータと payload を分けて持つ。payload は入力時に `serializer.serialize` で `Uint8Array` にして保持し（`Buffer` ではなくコピーを取る）、取得時に `deserialize` で復元する。利用者が書き込み後に payload を変更しても、取得結果を変更しても保存値は変わらない。T-6 を超える要件（複製可能性など）は課さない |
| MEM-7 | 排他制御の**前**に、入力検査（T-9・W-6・W-9・T-11〜T-13）と payload の直列化を終える。排他制御の**中**で、ヘッドの読み取り・照合（W-3・W-7・W-8）・変更の準備・まとめての公開（確定）・保持処理を行う。準備中の失敗は記録を変えない。イベントだけで seqNr=1 の新規作成もできる（スナップショットなし） |
| MEM-8 | `getLatestSnapshotById` は同じ排他制御の中でヘッドとスナップショットを読む。`headSeqNr` と封筒が同じ時点の値になる（R-8: 原子的） |
| MEM-9 | `getEventsByIdSinceSeqNr` は同じ排他制御の中で全件を読み、昇順で返す。復元は排他制御の外で行ってよい（直列化済みの `Uint8Array` を取り出した後） |
| MEM-10 | 保持件数がなければ現在のスナップショットだけを持つ。n ありなら新しい n 件の履歴を残し、古い順に取り除く。確定後に同じ排他制御の中で行う。イベントだけの追記でも、取り残された履歴を片付ける。ジャーナルとヘッドは取り除かない |
| MEM-11 | 保持の失敗は書き込みの成功を変えない。排他制御を解いた後に `onRetentionFailure` と `logger` で通知する。次の追記後の保持処理で再試行する（毎回、超過分を再計算するので自然に再試行になる） |
| MEM-12 | TTL 方式の要求は設定エラー |
| MEM-13 | 変更フィードを提供しない。`changeFeed` が指定されたら生成時に設定エラー（MEM-3） |

- 「確定」は、新しいヘッド・ジャーナル項目・スナップショットを組み立て終えてから、1回の代入（不変な記録の置き換え）で公開する。公開前の途中状態は誰にも見えない（H-1・MEM-4）。
- 保持の失敗を試験で起こすために、内部にフック（保持処理の差し替え口）を持つ（5.3）。公開 API には出さない。
- 適合の事例（memory.md 9章）は、5章の実行器と、`memory-event-store.test.ts` の作り直しで確かめる。

## 4. DynamoDB の実装方針

置き場所は `packages/library/src/internal/dynamodb-event-store.ts` を作り直す。現行は論理シャードのキー（`pkey` と `skey` の組）、ミリ秒の `occurred_at`、保持失敗を書き込み失敗にする挙動を持つ。全面的に置き換える。

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

1. 設定項目 `__config__` の3件（journal は `seq_nr=0`、snapshot は `skey=0`、head は SK なし）を、1回の `BatchGetItem`（`ConsistentRead=true`）で読む。
2. `UnprocessedKeys` は、そのキーだけを指数バックオフで強整合のまま再要求する。`Responses` は蓄積する。未処理がなくなるまで「存在しない」と判定しない。再要求の上限（`retryLimit`、初回を数えない）に達したら**保存先エラー**を返す（設定エラーにしない）。
3. 3つともなければ、新しい `store_id`（ランダム値）を作り、1つの `TransactWriteItems` で `attribute_not_exists(aid)` 条件付きの `Put` を3件行う。属性は `store_id`(S) と `layout_version`(N, 1) だけ。snapshot の設定項目は `active_history_seq_nr` を持たない。条件不成立（別の実行器が先に作った）なら、応答を捨てて3件を強整合で読み直し、手順4へ。
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
- `CancellationReasons` が複数ある場合の優先順位は、仕様が決めていない部分があれば10章の項目4に書く。
- **D-7**: 書き込み前に項目サイズを見積もり、409600 バイトを超えれば契約違反（`rule: "D-7"`）にする。`payload` は journal と head の両方に載るので、両方の項目を見積もる。属性名・型タグを含めた DynamoDB の項目サイズの計算規則を使う。
- **T-3**: `occurred_at` は `BigInt(date.getTime()) * BigInt(1000000)` の10進文字列を `N` で書く。読むときは BigInt で受け取り、ミリ秒の `Date` に戻す。浮動小数点を介さない。現行の `tsconfig` は target es6 なので、BigInt リテラル（`1n`）と数値区切りは使わず、`BigInt()` 関数を使う。`BigInt` の型を使うには `lib` に `es2020.bigint` が要る（`tsconfig` の変更は PR 1 で確認する。未確認）。
- **H-1**: 1つのトランザクションでヘッド・ジャーナル・スナップショットが確定する。変更フィードの供給源は head の Streams だけ（journal の Streams は使わない）。
- 保持処理（4.5）は、トランザクションの**確定後**に行う（D-9）。

### 4.4 読み取り（DY-9・DY-10・DY-11・R-8）

- `getLatestSnapshotById`: head の項目と、現在のスナップショット（`skey = 0`）を1回の `BatchGetItem`（強整合）で読む（DY-9）。`UnprocessedKeys` は読み切るまで再要求する。ヘッドがなければ `undefined`、あれば封筒（なくてもよい）と `headSeqNr` の組（DY-10）。2項目の読み取りは**原子的でない**（R-8）。`TransactGetItems` は使わない（P-25）。
- `getEventsByIdSinceSeqNr`: journal に `aid = :aid AND seq_nr >= :seq_nr`、`ConsistentRead = true` で `Query` する。昇順で、`LastEvaluatedKey` が返る間は読み切る（DY-11、R-5）。
- 復元できない項目（必須属性の欠損、`payload` が `B` でない）は**保存先エラー**（読み取ったデータの欠損）にする。直列化の復元失敗は直列化エラー。

### 4.5 保持処理（8章・D-3・D-9・P-18・P-24・S-2・S-3・S-4）

履歴を書いた書き込みの**確定後**にだけ行う（D-9）。

1. 疎な GSI を `aid = :aid`、`ScanIndexForward = false` で `Query` し、読み切る（KEYS_ONLY）。
2. 今書いた履歴を加え（GSI に見えていれば重ねない）、降順の先頭 n 件を残し、それより古いものを対象にする（S-2）。
3. 削除方式: `BatchWriteItem` を25件ずつ（P-18）。`UnprocessedItems` は再送する。
4. TTL 方式: 1件ずつ `UpdateItem`。`SET #ttl = :expires REMOVE active_history_seq_nr`、条件 `attribute_exists(active_history_seq_nr)`。`#ttl` は `ExpressionAttributeNames`（`ttl` が予約語のため）。`:expires` は印付け時点のエポック秒＋猶予秒。後の更新が条件失敗したら、印付け済みとして読み飛ばす。
5. 件数を数えてから超過分を選ぶ方式は使わない（P-24）。印付き履歴は件数に数えず、期限は先送りしない（S-3）。
- 失敗は書き込みの結果を変えない（S-4）。`onRetentionFailure` と `logger` で通知する。現行の `dynamodb-snapshot-retention-executor.ts` の、保持失敗を書き込み失敗にする挙動は置き換える。
- 現行の `deleteTtlMillis`（ミリ秒）は、`graceSeconds`（秒、`ttl` 属性はエポック秒）に置き換える。

### 4.6 変更フィード

head の Streams を有効にするのはテーブル側。ライブラリは、`aid = __config__` のレコードを読み飛ばす（DY-13）関数を提供するかどうかを、9章の項目3で確認する。

## 5. 適合テストデータの実行器

### 5.0 置き場所と実行方法

- 実行器は `packages/library/src/internal/conformance/` に置く（内部。公開しない）。ライブラリの内部モジュールとフックへ、公開 API を増やさずに触れるためである。
- 実行は Jest（現行の試験基盤）から行う。1つの試験ファイル（`conformance.test.ts`）が、`conformance/` の全ファイルを読み、ケースごとに試験を動的に作る。保存先（メモリ・DynamoDB）ごとに実行する。
- `conformance/` は、ハブと同一内容で写してある。実行器は `conformance/` を**書き換えない**。

### 5.1 データの読み方

| 論点 | 方針 |
|:--|:--|
| 読み込み | UTF-8 の JSON。最上位の `format` と `version` を確認する。重複キーは検出して失敗にする。標準の `JSON.parse` は重複キーを検出しないので、`manifest.py verify` が通っていることに依存し、実行器自身でも検査する案を取る（実装時に確認） |
| 任意精度整数 | `seq_nr` の `-1` や `2^53` を、汎用の JSON 値として読む。数値は `JSON.parse` の reviver の `context.source`（Node.js 24 で使えるかは未確認）か、独自の字句解析で `bigint` として読む。`number` へ直接変換しない。`epoch_nanoseconds` は10進文字列で、`bigint` で計算する |
| 型への変換 | `bigint` から `number` へは `Number.isSafeInteger` の範囲で変換する。範囲外の値（例: 2^53 を超える値）はライブラリの検査に渡せないので、「表現不能」と報告する。2^53 そのものは `number` で表せるので、T-9 の上限超過として実行する |
| 時刻 | `occurred_at` は9桁小数秒の UTC ISO 8601 を読み、`bigint` のエポックナノ秒へ変換する |
| 精度の方針 | `precision_policy = native-time-type` の成功ケースは、入力を `Date`（ミリ秒）へ変換した値を期待値とする（丸めの向きは固定しない）。実行器は変換した値と実際の値を報告する。`representation.time_precision = nanoseconds` のケースは、対象外（表現不能）とし、理由を記録する。`milliseconds` のケースは実行する。印のないケースは全実装が実行する |
| 負数 | `representation.signed_seq_nr = true` は実行する（`number` は負数を表せる） |
| 値の表の操作 | `buildAid` は `AggregateId.of` と `AggregateId.asString`。`validateSeqNr` は `EventEnvelope.create`（`context=event`）と、値域だけを検査する内部関数（`context=value`）。`validateOccurredAt` は `EventEnvelope.create` を使って、ケースの手順（型名 `ConformanceTime`、値がケース ID）で `persistEvent` する。`fnv1a64` は共有ハッシュ実装を使うプロファイルがないので、DynamoDB もメモリもハッシュを保存キーに使わない。対象外として理由を記録する（9章の項目5、10章の項目2） |
| payload の比較 | 既定 JSON で復元した値を、キー順・空白を無視して比較する。配列順・`null`・真偽値・文字列・数値は保つ。真偽値と数値を同一視しない。Unicode 正規化はしない |
| generators | `target`（JSON Pointer）の空文字列を、`character`（Unicode の1文字）を `byte_length`（UTF-8 総バイト数）に達するまで反復して展開する（`byte_length` ÷ 文字の UTF-8 幅 回。割り切れない指定はデータの誤りとして失敗にする）。`~0`・`~1` を復号する。Schema 検査は展開前、操作は展開後。参照実装は `tools/conformance/data.py` の `materialize` |
| サイズ | 400KB は 409600 バイト、1MB は 1048576 バイト |

### 5.2 場面の実行手順と、ストアの分離

各場面は独立したストアで実行する。手順は `conformance/README.md` に従う。

1. `backends` に実行する保存先があるか確認する。`requires = ["ttl"]` はメモリでは対象外（MEM-12。v1 の TTL 場面は DynamoDB だけ）。
2. `store` の設定からストアを生成する。`retention_count = null` は履歴なし。`retention_mode`（delete / ttl）と `ttl_grace_seconds` は `SnapshotRetention` へ対応付ける。
3. `seed.items` があれば、ストア生成の前にテスト用の権限（実行器自身のクライアント）で入れる。
4. `initialization` があれば、生成結果を検査する。生成失敗のケースは操作列がない。生成前の障害は先に登録する。
5. generators を展開し、`fixtures.events`・`fixtures.snapshots` を各操作の直前に封筒として構築する。無効な入力の封筒構築中の規則違反も、その操作の失敗として捕捉する。実行器の事前検査でライブラリの検査を代替しない。
6. `steps` を配列順に、並行実行せずに実行する。
7. 各操作の `expect` と `observe` を検査する。保持失敗や遅延のある場面は、保持・検査フックの完了後に観測する。フックは書き込みの成功・失敗を変えない。
- `retry_limit` は設定照合の再要求回数の上限（初回は数えない）。`DynamoDBEventStoreInput.retryLimit` に対応付ける。指数バックオフは、時計フック（`sleep` の差し替え）で実時間を短縮してよい。

**DynamoDB のストア分離**: 場面ごとに、実行器が3テーブルと GSI を新しく作る。テーブル名は `conf-<連番>-<ランダム>-journal` のように場面ごとに一意にし、3テーブルを同じリージョンに作る。GSI 名は固定の名前でよいが、テーブルが場面ごとに別なので衝突しない。場面の終了時に3テーブルを削除する。他のケースの項目を使い回さない。作成はテスト側の `CreateTable`（現行の `dynamodb-utils.ts` を作り直す）で行う。DynamoDB Local での作成コスト（場面85件のうち DynamoDB は43件）は、場面ごとのテーブル作成で許容できる範囲かを、CI の実行時間で確認する（10章の項目6）。

**メモリのストア分離**: 場面ごとに `MemoryStorage.create()` で新しい記録を作る。

### 5.3 フックの置き場所

フックは内部の生成関数（`createDynamoDBEventStoreInternal(input, hooks)`、`createMemoryEventStoreInternal(input, hooks)`）の第2引数で渡す。公開の `EventStore.createDynamoDB` は、フックなしで内部関数を呼ぶ。

| フック | 置き場所 |
|:--|:--|
| 保持の決定的実行 | 内部フック `retentionScheduler`。通常は書き込み確定後に即時実行する。実行器は、完了を待てる実行（`await` できる `Promise`）を受け取り、`observe` の前に待つ。ライブラリ内部で保持処理を `Promise` として返す |
| 内部履歴の検査（`observe.history`） | DynamoDB: 実行器のクライアントで、その集約の snapshot テーブルの項目を `Query`（強整合）して、active（`active_history_seq_nr` あり）と marked（`ttl` あり）に分類する。現在のスナップショット（`skey = 0`）と設定項目は数えない。メモリ: 内部の論理履歴を読む内部アクセサ |
| 失敗通知の検査（`observe.notifications`） | `onRetentionFailure` の受け取りを記録する。同じ最終失敗のログが複数あれば1つに正規化する |
| SDK 要求の検査（`observe.requests`） | ミドルウェア（5.4）が、送信前の入力を記録する。式は構文解析して、式と属性名・値の束縛の構造で比較する（空白・節の順序・AND の順序は比較しない） |
| 属性検査（`observe.items`・`seed.items`） | 実行器のクライアントで `GetItem`。属性集合を完全一致で比較する。`N` は10進文字列を整数として比較。`binary_json` は `B` の復元結果を JSON で比較 |
| 時計 | 内部フック `clock`（`() => epochSeconds`）。TTL の印付けの期限が「印付け時刻＋猶予秒」になる。v1 は2100年の時計 |
| 配置照合（`dynamodb/layout.json`） | 実行器が `DescribeTable` と `DescribeTimeToLive` で、作成した3テーブルを照合する。テーブル名と GSI 名は設定値に束縛する |
| SDK 要求のサイズ検査 | D-7 は、ライブラリの見積もりを検査する |

### 5.4 SDK の差し込みの位置

DynamoDB は、`DynamoDBClient.middlewareStack` に、実行器が追加するミドルウェアで差し込む。

- 位置: `step: "initialize"` ではなく、`finalizeRequest` 段階（リトライと署名の後）に置く案と、`build` 段階（入力が組み上がった後、リトライの前）に置く案がある。**自動再試行を無効**にするため、実行器が作るクライアントは `maxAttempts: 1` にする。差し込みはシリアライズ後（`serialize` 段階の後）にコマンド名と入力を観測する。どの段階が最適かは、実装の最初の PR で小さな試作で確かめる（10章の項目7。この設計では推定である）。
- `replace-request`: ミドルウェアが `next` を呼ばず、例外または応答を返す。何も確定しない。v1 の書き込み失敗と保持失敗は全てこれ。
- `replace-response`: `next` を呼んだ後に、応答を差し替える。副作用は残る。
- 保持処理の要求だけを失敗させる（IP 6）。ミドルウェアは、コマンド名と、テーブルと GSI の対象（`QueryCommand` の `IndexName`、`BatchWriteItemCommand`、`UpdateItemCommand` の対象）で対象を絞る。書き込みのトランザクションは失敗させない。
- 差し込みの登録・消費・未発火の検査（登録した障害が発火しなければ場面は失敗）は、実行器が持つ。ライブラリ本体にミドルウェアを置かない。ライブラリは、渡されたクライアントをそのまま使う。

### 5.5 障害の差し込み（12段階）

指示書は「13段階」と書いているが、`conformance/schema/common.schema.json` の `phase` の列挙は12個である（10章の項目1）。この設計は12個について書く。

| 段階 | DynamoDB | メモリ |
|:--|:--|:--|
| `serialize-event` | イベントのシリアライザをラップし、`serialize` を失敗させる | 同じ（排他制御の前に失敗するので記録は変わらない） |
| `serialize-snapshot` | スナップショットのシリアライザをラップ | 同じ |
| `deserialize-event` | イベントのシリアライザの `deserialize` を失敗させる | 同じ |
| `deserialize-snapshot` | スナップショットのシリアライザの `deserialize` を失敗させる | 同じ |
| `commit` | `TransactWriteItems` のミドルウェア。`replace-request`（`TransactionCanceledException` の組み立てを含む）と `replace-response`。`cancellation_reasons` は5.7 | 確定の直前（まとめて公開の前）の内部フックで失敗させる。ヘッド・ジャーナル・スナップショットに変更を残さない。SDK の例外はないので `sdk-error` 系は**差し込めない**（未検証と報告。代わりに、確定前の失敗で記録が変わらないことを `storage-error` のケースで確かめる） |
| `read-events` | `QueryCommand`（journal）のミドルウェア | 読み取り直前の内部フック |
| `read-snapshot` | `BatchGetItemCommand` のミドルウェア（`sdk-response` の応答計画、`read-interleave` を含む） | 読み取り直前の内部フック。`read-interleave` は R-8 が原子的なので対象外（理由を記録） |
| `retention-query` | GSI の `QueryCommand` のミドルウェア（`history_pages` の応答計画を含む） | 論理履歴の列挙フック。`history_pages` の履歴 seq_nr のページ列を、論理履歴の列挙結果として連結して返す（今書いた履歴は自動追加しない）。メモリにページ送りはないので `LastEvaluatedKey` と `ExclusiveStartKey` の対応付けは行わない。保持対象の選択結果は `observe.history` で確かめる |
| `retention-delete` | `BatchWriteItemCommand`（`unprocessed_first_n` を含む） | 論理履歴の削除フック。`BatchWriteItem` の分割は存在しない |
| `retention-mark` | `UpdateItemCommand`（snapshot の TTL 印付け） | TTL がないので**対象外**（MEM-12） |
| `configuration-read` | 生成時の `BatchGetItemCommand`（`unprocessed_keys`） | 設定の読み取りがないので**対象外** |
| `configuration-create` | 生成時の `TransactWriteItemsCommand`（`install_items` による生成競合を含む） | 設定の作成がないので**対象外** |

- メモリを対象に含む障害ケースは、`conformance/scenarios/core/retention-errors.json` に11件ある（`conformance/` を走査して確認した範囲）。`retention-query` の `history_pages` を指定するのは、`core-retention-delete-1`・`core-retention-delete-2`・`core-retention-failure-after-commit`・`core-retention-query-failure` の4件で、上の対応付けで差し込む。残り7件は、`core-serialize-event`（`serialize-event`）、`core-serialize-snapshot`（`serialize-snapshot`）、`core-deserialize-event`（`deserialize-event`）、`core-deserialize-snapshot`（`deserialize-snapshot`）、`core-storage-commit-failure`（`commit`）、`core-storage-read-events`（`read-events`）、`core-storage-read-snapshot`（`read-snapshot`）で、いずれも上の表のメモリ列のフックで差し込む。それ以外の段階でメモリに差し込めないものが実行対象に現れた場合は、理由つきで「未検証」と報告し、成功に集計しない。
- `kind` の扱い: `serialization-error` はシリアライザの対応段階を失敗させる。`storage-error` は保存先・保持フックの最終失敗（`details.scope = final-retention-failure` は、候補選択後・削除前に保持全体を失敗させる）。`sdk-error` は、`details.code` と `cancellation_reasons` から SDK の例外クラス（`TransactionCanceledException` など）を組み立てる。`sdk-response` は応答計画。`read-interleave` は DY-9 の非原子的応答。
- `read-interleave`: 送信直前に旧ヘッドを捕捉し、`interleaved_operation` の追記を確定し、元の `BatchGetItem` を送って、応答内のヘッドを旧ヘッドへ差し替える。実時間の競争は使わない。実行器が別のストアインスタンスで追記を行う。
- `repeat`: `{ "mode": "count", "count": 1 }` か `{ "mode": "until-operation-finishes" }`。ミドルウェアが、発火回数を数える。

### 5.6 `observe.requests` の検査

- 式は、実行器内の小さな構文解析で `SET`・`REMOVE`・条件式の構造に分解する。空白・節の順序・AND の順序は比較しない。
- `key_condition.all`（`eq` / `gte` と `aggregate_id`・`seq_nr` の束縛）、TTL の `#ttl` と `ExpressionAttributeNames`、`expires`（エポック秒）、`initial_batch_sizes`（再送を除く削除バッチ件数）、`no_requests_in_phases`、`request_count`、`minimum_request_count` を検査する。
- `requests` の要素は、実際の別々の要求に配列順で対応付ける。ページ送り・未処理キーの再要求・削除バッチ分割は、段階の要求列全体で検査する。

### 5.7 `cancellation_reasons`

トランザクションの各アクションに1要素。書き込みは journal・head・current-snapshot・history-snapshot の順（存在するアクションだけ）。設定作成は `configuration:journal`・`configuration:snapshot`・`configuration:head`。失敗していない要素の `Code` は文字列 `None`。実行器は、対象名を実際の要求内のアクションに照合して並べ直す（ライブラリの要求順を強制しない）。head の `ConditionalCheckFailed` は `old_head_seq_nr`（`null` は旧項目が返らない）を持つ。D-5 の分類はこの旧項目を使う。

### 5.8 報告と CI

- 報告の形（JSON と、Jest の標準出力への要約の両方）:
  - データの版と `manifest.json` の照合結果。
  - 言語（`typescript`）、実装版（`package.json` の版）、保存先（`memory` / `dynamodb`）。
  - ケース ID と規則番号ごとの結果: `passed` / `failed` / `not-applicable`（対象外）/ `unverified`（未検証）。
  - 失敗した操作番号と、期待値・実際の値。
  - 表現能力の違いによる選択・任意能力・削除済み規則・呼び出し側の推奨の理由。
- 1ケースが複数の規則を持てば、全規則へ対応付ける。途中で期待と異なれば成功と報告しない（IP 5）。条件を満たさないケース、必須ケースを飛ばした結果、障害を差し込めなかった結果を成功に集計しない。
- 結果の表現名は、`conformance/README.md` の語に合わせる。語が異なれば README を優先する（実装時に確認）。
- 配布の検証: 現行 CI の `release-checks` に既にある `python3 tools/conformance/manifest.py verify` と、`manifest.json` の SHA-256（v1.0.0 は `61c26614dbbfba88eebce72cc1d2b0220218839e74dcfb64c19268f7ee2302ce`）の照合を、維持する。manifest を作り直して差分を隠さない。`conformance/.gitattributes` が改行変換を止めている。
- 実行: `pnpm --filter event-store-adapter-js run coverage --runInBand`（現行の `test` ジョブ）に含める。DynamoDB Local はテスト内で Testcontainers が起動する（6章）。実行時間が長ければ、専用ジョブに分ける（10章の項目6）。

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
| `packages/library/src/internal/dynamodb-event-store.test.ts` | LocalStack（`localstack/localstack:2.1.0`、ポート 4566） | 作り直し。DynamoDB の中核の試験は、適合の実行器に置き換える。DynamoDB 固有の単体試験（ミドルウェアなしで確かめられるもの）は、DynamoDB Local へ移す |
| `packages/library/src/internal/test/dynamodb-utils.ts` | 旧配置（journal と snapshot、`pkey` など）の `CreateTable` | 3テーブルと GSI の新配置の `CreateTable` に作り直す。ポートを 8000 に |
| `packages/library/src/internal/test/user-account-repository.test.ts` | LocalStack | DynamoDB Local へ。新 API に作り直す |
| `packages/examples/src/dynamodb-container.ts` | LocalStack | DynamoDB Local へ。例を新 API に作り直す |
| `packages/examples/README.md` | LocalStack の説明 | 文書の更新は段階の最後（5.0.0 の文書の PR）。今回は触れない |
| 依存 `testcontainers` | `^12.0.0` | 維持 |

- 移行は段階的に行う。LocalStack の試験は、DynamoDB の作り直しの PR で、DynamoDB Local の試験に置き換わる。両方を並べて維持しない。

## 7. main への入れ方

### 7.1 方針

実装計画 3 章の進め方に従う。main に PR ごとに squash マージする。main の Snapshot は次のメジャーの版（`5.0.0-snapshot.*`）で公開する。メジャーの公開は、受け入れ条件（IP 5）を満たした後、オーナーの承認を得て手動で出す。worker は PR の作成までで、マージはコーディネーターが行う（IP 9）。

### 7.2 各 PR で main の CI を通し続ける方法

現行の CI は、`lint`・`test`（ビルドと coverage）・`examples`（`pnpm run test:examples`）・`package-tests`（`pnpm run test:packages`）・`release-checks` と、集約の `ci-success` からなる。各 PR は、これらすべてを通す。

- `examples` と `package-tests` は、公開 API を使う。旧 API を消す PR は、同じ PR で、これらの利用側を新 API に移す。
- 旧 API を、削除の時点まで内部に残す。新しい中核・メモリ・DynamoDB は、最初は**別のファイル**（例: `src/next/` ではなく、新しい名前のファイル）で作り、公開 API の入口（`index.ts`）の切り替えは、利用側を移す PR（PR 6）で一度に行う。切り替えるまでは、新しい実装は `index.ts` から公開しない。`index.ts` から見えない新実装は、内部の試験だけで検証する。
- 旧 API と新 API の**公開上の共存はしない**。共存は、PR 1〜PR 5 の間の、内部の作業中の状態である。
- 新しい試験は、DynamoDB Local で動く。CI の Docker の実行が必要（現行の LocalStack と同じ前提）。

### 7.3 PR の列

| PR | 範囲 | 対応する規則群 | 備考 |
|:--|:--|:--|:--|
| PR 1: 下準備 | `packages/library/package.json` の版を `5.0.0-snapshot.0` にする（Snapshot の公開が、`snapshot.yml` の `replace(/-snapshot\.\d+$/, "")` により `5.0.0-snapshot.<run>.<attempt>` になる）。使っていない依存（`aws-sdk`・`moment`・`winston`・`@types/winston`）を外し、`pnpm-lock.yaml` を更新する。`bump-version.yml` の手動化の確認（IP-D1 の手順2の状態を確認する。未確認） | なし（IP-D1、IP 4.2） | コードの挙動は変えない。依存が使われていないことは、TypeScript の参照がないことで確認済み。`package-tests` で公開された版の参照が壊れないかを確認する |
| PR 2: 適合の実行器の基盤 | データの読み込み、場面の実行、報告、`manifest` の照合、フックの置き場所。実装計画 4.2 の順（実行器 → 中核）に従う。ライブラリの操作は、型の対応付けの境界（呼び出しの差し込み口）だけを置き、全ケースの合否は保存先の PR で有効にする。実行器の単体試験 | 5.1・5.2・5.8、IP 5 の1 | 実行器の入力の検査に `conformance/` を使う。各ケースの実行は、メモリ（PR 4）・DynamoDB（PR 5）の完成後に有効にする |
| PR 3: 中核 | 集約 ID、封筒、整数・時刻の型、`PayloadSerializer`、`EventStoreError`（5分類）、設定の型、入力検査、`EventStore` の型。新しい名前のファイルに置く。単体試験を付ける | T-1〜T-13、W-6・W-9・W-8（検査の部分）、E-1〜E-3、S-1 | `index.ts` から公開しない |
| PR 4: メモリ | 新しいメモリ実装。実行器でメモリの全ケース（障害の差し込みを含む）を有効にして通す。現行の `memory-event-store.test.ts` を置き換える | MEM-1〜MEM-13、W-3〜W-9、R-1〜R-6、R-8 | |
| PR 5: DynamoDB | 新しい DynamoDB 実装（3テーブル、設定項目、書き込み、読み取り、保持）。実行器の DynamoDB のフック・ミドルウェア・テーブル分離。DynamoDB Local へ移す（6章）。layout と item-shapes の照合 | D-3〜D-9、DY-1〜DY-19、P-18・P-19・P-24・P-25・P-40、S-2〜S-4、IP 5 の1・2 | 大きいので、2つに分けてよい（書き込み・読み取りと設定項目 → 保持処理）。分けるときは、規則群で分ける |
| PR 6: 切り替え | `index.ts` を新 API に切り替える。旧 API・旧実装（`aws-sdk` 依存の残り、`shard-*`、`default-serializer`、旧 `dynamodb-*`、旧 `memory-*`、Spanner 一式）を削除する。`examples` と `packages/tests` を新 API に移す。LocalStack を残さない | 削除の時点 | 旧 API の削除はこの PR。`package-tests` と `examples` が新 API で通る |
| PR 7: 文書 | README（英語・日本語）、スキーマの文書、移行ガイドを新契約に合わせる（IP 5 の5・6）。8章の手順書 | IP-D8 | 文書は、コード PR の後 |
| 公開 | オーナーの承認後に、手動で 5.0.0 を出す（実装計画 3 章） | IP 5 | 保守版の公開に `--tag` が要る（`snapshot.yml` は `--tag snapshot`、リリースは現状 `--tag` なし。実装計画 3 章の指摘） |

- PR 6 で Spanner のコードを外すと、`@google-cloud/spanner` の peer 依存・devDependencies も外れる。段階5で出し直すときに戻す。
- 各 PR の規則群が1つに絞れないものは、規則群の主なものを書いた。1つの PR が1つの規則群に対応する（IP 9）ように、PR 5 は分割してよい。

## 8. 移行の案内

### 8.1 対象

現行メジャー（4.x）の利用者向けの案内。実装計画 7 章（IP-D8）に従い、js の旧配置の DynamoDB には**移行ツールを提供せず、手順書だけを用意する**。手順書は PR 7 で作る。今回は骨子だけ書く。

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

どの項目も、**決めていない**。選択肢・それぞれの利点と欠点・推奨とその理由を示す。オーナーが決める。

### 項目1: 読み取りと書き込みの失敗を `Result` で返すか、例外で返すか

現行は、書き込みが `Result<void, EventStoreError>`、読み取りと生成が例外（`Promise` の拒否）である。この設計では、読み取りと生成の失敗も分類して返す（4.2）。

| 選択肢 | 利点 | 欠点 |
|:--|:--|:--|
| A: 全操作を `Result` で返す（書き込み・読み取り・生成） | 失敗が型に出る。`type` で分類を網羅的に分岐できる（E-1）。現行の書き込みと揃う。`Result` は既に公開している。他言語（rs の `Result`）と形が近い | 現行の読み取りの利用者は、例外から `Result` への書き換えが要る。`await` の度に分岐が要る。`Result` の `value` の取り出しが冗長 |
| B: 全操作を例外（`EventStoreException`。`error: EventStoreError` を持つ）で返す | JS の慣習に近い。呼び出しが簡潔。`try/catch` の1か所で扱える | 失敗が型に出ない。投げ忘れを型で検査できない。現行の書き込みの利用者が書き換え。`instanceof` と `type` の両方が要る |
| C: 書き込みは `Result`、読み取りと生成は例外（現行のまま） | 利用者の書き換えが最小 | 読み取りの失敗の分類（直列化・保存先・設定）を `Error` のサブクラスや `cause` で作る必要があり、E-1 の判別の形が2系統になる。指示書の「読み取りと生成の失敗も分類して返す」を弱める |
| D: 書き込みと読み取りは `Result`、生成は例外 | 生成の失敗は起動時の設定の誤りで、プログラムの誤りに近い。生成が簡潔 | 生成の失敗（保存先エラーを含む）は、DynamoDB の入出力が絡むので分類が要る。2系統になる |

- **推奨**: A。失敗の分類を型で判別でき（E-1）、書き込みの現行の形を保てる。読み取りの書き換えは、5.0.0 が破壊的変更なので許容できる。契約違反（プログラムの誤り）まで `Result` にするのが過剰だと考える場合は、オーナーが B・D を選ぶ余地がある。
- この文書の2章の型は、A を**仮置き**している。B・C・D を選ぶと、2.7 の戻り値と 2.8 の周辺が変わる。

### 項目2: Spanner を任意の依存にするエントリポイントの分け方（案だけ。段階5までに決める）

現行は `@google-cloud/spanner` を peer 依存（`^8.7.1 || ^9.0.0`）にし、メインの入口が型として Spanner を import する。

| 選択肢 | 利点 | 欠点 |
|:--|:--|:--|
| A: サブパスのエクスポート（`event-store-adapter-js/spanner`）。`package.json` の `exports` を使う | 利用者は Spanner を使うときだけ import する。メインの入口に Spanner の型が出ない。1パッケージのまま | `exports` の設定が要る。CommonJS・`moduleResolution` の古い設定の利用者が、サブパスの型を見つけにくい。`typesVersions` の併用が要る可能性 |
| B: 別パッケージ（`event-store-adapter-js-spanner`） | 依存が完全に分かれる。版を別に出せる | モノレポのパッケージとリリースの仕組みが増える。中核との版の組み合わせが増える。現行のリリース（単一パッケージ）の変更が大きい |
| C: 現行のまま、メインの入口から Spanner を出す（peer を任意にする `peerDependenciesMeta.optional`） | 変更が最小 | メインの入口の型が Spanner の型を import するので、Spanner を入れていない利用者の型検査が壊れる（`skipLibCheck` に依存する） |

- **推奨**: A。1パッケージを保ったまま、メインの入口から Spanner の型を外せる。段階5で出し直すときに、`peerDependenciesMeta` で任意にする。最初のメジャー（5.0.0）では、Spanner のコードは出さないので、この項目は 5.0.0 には影響しない。
- 最初のメジャーから、**中核の型が Spanner を参照しない**ようにしておく（2章のとおり。`EventStore` は保存先に依存しない）。

### 項目3: 変更フィードの扱い

head テーブルの Streams のレコードからヘッド遷移を組み立てる関数と、再同期（DY-15）の補助を、最初のメジャーに含めるか。

| 選択肢 | 利点 | 欠点 |
|:--|:--|:--|
| A: 含めない（Streams を有効にしたテーブルを前提にする。DY-3・DY-12 の形を守るだけ） | 最初のメジャーの範囲が小さい。IP-D3（中核・DynamoDB・メモリだけ）に最も近い | 利用者が、Streams のレコード（`NEW_IMAGE`、INSERT / MODIFY、`__config__` の読み飛ばし、DY-13）を自分で解釈する。解釈の誤りが利用者側に出る |
| B: ヘッド遷移を組み立てる関数だけ含める（DY-12・DY-13） | 変更フィードの契約の読み方をライブラリが保証できる。再同期は含めないので、範囲は中くらい | DY-15 の再同期は利用者が書く。関数の公開 API を足す（T-5 の流儀の検討が要る）。メモリは変更フィードがない（MEM-13）ので、DynamoDB だけの API になる |
| C: 関数と再同期の補助（`Scan` を使う。DY-19 の例外）を含める | 利用者にとって完結する | 最も大きい。`Scan` の権限と運用の検討（IAM、スループット）が要る。範囲が最初のメジャーを超える恐れ。テストの追加が大きい |

- **推奨**: A。IP-D3 の範囲に収まり、仕様の合意の範囲を超えない。必要が出れば 5.x の機能追加として足せる（足すのは後方互換な追加）。
- 適合テストデータに変更フィードのケースがあるか（未確認）。あれば、A では対象外にできず、B が必要になる。実装の最初の PR の前に確認する。

### 項目4: `occurredAt` の型（`Date` か、ナノ秒の `bigint` か）

| 選択肢 | 利点 | 欠点 |
|:--|:--|:--|
| A: `Date`（ミリ秒精度） | 現行と同じ。JS の標準の時刻型。T-3 は「標準時刻型の精度まで丸めてよい」としている | `nanoseconds` のケースが実行できない（対象外）。他言語とのナノ秒の往復で精度が落ちる（旧データはミリ秒なので、移行では影響しない） |
| B: エポックからのナノ秒を `bigint` で持つ | 9桁の精度を保てる。T-13 の範囲検査が厳密。`nanoseconds` のケースも実行できる | 標準の時刻型ではない。利用者が `Date` へ変換する必要がある。JSON のシリアライズ（`bigint` は直接直列化できない）に注意が要る |
| C: 両方を受け取れる型（`Date | bigint`）。保存は `bigint` | 利用者は好きな方を使える | 型が複雑。読み取りで返す型の選択が要る。T-5 の「要素の追加が既存を壊さない」形の検討が要る |

- **推奨**: A。現行の利用者の型と同じで、T-3 の許容の範囲に収まる。ナノ秒のケースは対象外として理由を記録できる（5.1）。ナノ秒の必要が出れば、5.x で足せる。
- 2章の `occurredAt: Date` は、A を**仮置き**している。

### 項目5: （設計の途中で見つけた）`fnv1a64` の扱い

値の表の操作 `fnv1a64` は、「ハッシュを使うプロファイルの共有ハッシュ実装」に対応付ける（付録）。DynamoDB は保存キーにハッシュを使わず（DY-16）、メモリも使わない（MEM-5）。

| 選択肢 | 利点 | 欠点 |
|:--|:--|:--|
| A: 対象外として理由を記録する | 使わない関数を作らない（YAGNI）。仕様の読み方どおり | 付録の「全ケースを通す」（IP 5 の1）の文面と食い違うように見える。報告で対象外が増える |
| B: 実行器の内部だけに FNV-1a の実装を持ち、ケースを通す | 全ケースが成功になる | ライブラリが使わないコードを作る。ライブラリの試験ではなく、実行器の自己検査になる（実行器の中だけで検査を完結させてはならないという趣旨に反する） |

- **推奨**: A。適合データの意図（共有ハッシュを使うプロファイルのため）と、ライブラリの保存キー（ハッシュを使わない）に合う。10章の項目2にも、読み方の確認を書く。

### 項目6: `PayloadSerializer.deserialize` が `manifest` を受け取るか

| 選択肢 | 利点 | 欠点 |
|:--|:--|:--|
| A: `deserialize(bytes, manifest)` | 複数の型の payload を1つのシリアライザで復元できる。manifest を解釈するのは利用者 | シリアライザの型が、共通契約の「payload だけを扱う」（T-7）に近い範囲で、manifest を受け取る。T-4（ライブラリは解釈しない）は守る |
| B: `deserialize(bytes)` | T-7 の文面に最も近い。型が単純 | 型の分岐ができず、利用者は payload の中に型情報を入れる必要が出る（T-7 は埋め込みを禁じるのは「メタデータ」で、ドメインの型情報は payload の一部なので許される） |

- **推奨**: A。manifest の本来の用途（payload の型の識別）を果たせる。ライブラリは受け渡すだけで、解釈しない。

### 項目7: 適合の実行器の置き場所

| 選択肢 | 利点 | 欠点 |
|:--|:--|:--|
| A: `packages/library/src/internal/conformance/`（内部） | 公開 API を増やさずに内部フックに触れる。現行の試験基盤（Jest）を使う | ライブラリのパッケージに実行器のコードが入る（`files` で `dist` の除外が要る） |
| B: 別のワークスペース `packages/conformance` | 実行器が分かれる。公開物に入らない | 内部フックへの入口（`exports` のサブパスなど）が要り、公開 API が増えるか、フックのために内部を公開する |

- **推奨**: A。ビルドの成果物（`dist`）から試験を除外する既存の設定を確認して使う（未確認）。

### 項目8: メモリの複数スレッド（`worker_threads`）からの利用（MEM-4）

| 選択肢 | 利点 | 欠点 |
|:--|:--|:--|
| A: 同一スレッド内の非同期の並行呼び出しだけを保護する（Promise の直列化） | 実装が単純。JS の通常の利用に合う | 複数スレッドの保護という MEM-4 の文面を、同一スレッドの範囲に読み替える。10章の項目3の確認が要る |
| B: `SharedArrayBuffer` と `Atomics` で排他制御し、記録も共有できる表現にする | MEM-4 の文面を満たす | 記録の表現（直列化したバイト列の共有領域）と、領域の管理が複雑。性能と実装量が大きい |
| C: 複数スレッドからの利用を、スレッドごとに別の記録を持つ（共有しない）ものとして文書に明記する | 実装が単純 | MEM-2 の「明示的な共有」を、スレッドをまたいでは提供しないことになる |

- **推奨**: 判断材料が足りないため、10章の項目3の確認を先に行う。仕様が同一スレッドの範囲で足りるなら A、複数スレッドが必須なら B。この文書は、どれも決めていない。

## 10. 未解決の疑問

仕様の読み方が分からない点、仕様と食い違うように見える点。仕様を勝手に解釈して埋めない。

1. **障害の差し込みの段階の数**: 指示書は「13段階」と書く。付録の2章も「phase は13種」と書くが、列挙されているのは12個で、`conformance/schema/common.schema.json` の `phase` の列挙も12個である。13個目があるのか、数え間違いなのかが分からない。この設計は12個で書いた。
2. **`fnv1a64`**: 付録は「ハッシュを使うプロファイルの共有ハッシュ実装へ対応付ける」と書く。DynamoDB もメモリもハッシュを保存キーに使わない。js の実行器でこのケースを「対象外」にするのが正しいかが分からない。9章の項目5に選択肢を書いた。
3. **メモリの「複数スレッド」の保護（MEM-4）**: JS の通常のオブジェクトは `worker_threads` 間で共有できない。「複数スレッドからの並行呼び出し」を、同一スレッド内の非同期の並行呼び出しだけと読んでよいか。`SharedArrayBuffer` を使う共有は想定しない読みでよいか。
4. **`CancellationReasons` の分類の優先順位**: 1つのトランザクションの取り消しで、journal の条件不成立と head の条件不成立が同時に起きたとき、どちらで分類するかを、仕様と適合データのどこが決めているかを、実装時に確認する（未確認）。W-7 と D-5 の両方が楽観ロックなので、分類は同じになる可能性が高いが、W-8 の飛び番（契約違反）と W-7（楽観ロック）が同時に起きる場合の優先順位は、仕様を読み切れていない。
5. **2^53 を超える `seq_nr` の表現**: `number` は 2^53 まで正確に表せる。2^53 を超える値を使うケースが適合データにあるかは未確認。あれば「表現不能」と報告するのが正しいか。
6. **場面ごとのテーブル作成のコスト**: DynamoDB の場面は43件。場面ごとに3テーブルを作る前提だが、実行時間が CI の制約に収まるかは未確認。収まらない場合に、テーブルを再利用してよいか（「他ケースの項目を使い回さない」に反しない形で、項目を消して再利用する案）。
7. **ミドルウェアの差し込みの段階**: `maxAttempts: 1` と `replace-request`・`replace-response` を実現するミドルウェアの段階（`build`・`finalizeRequest` など）は、SDK の版で挙動が変わりうる。実装の最初に、小さな試作で確かめる必要がある。
8. **DynamoDB Local 3.3.1 の挙動**: `ReturnValuesOnConditionCheckFailure = ALL_OLD`、`TransactionCanceledException` の `CancellationReasons` の `Item`、TTL の有効化と `DescribeTimeToLive` が、DynamoDB Local 3.3.1 で期待どおりに動くかは、この設計では確かめていない。hub の `tools/spikes/dynamodb-emulators/` の記録を読む必要がある。
9. **`seqNr` を `number` にした場合の `Date` と T-13 の検査**: ミリ秒の `Date` を、ナノ秒の符号付き64bitの範囲で検査する（2.3）。範囲の端（約 1677 年・2262 年）で、ミリ秒の丸めの向きによって、範囲内・範囲外の判定が変わる値がある。適合データの `occurred-at-min`・`occurred-at-max`・`below-min`・`above-max` を `Date` でどう扱うか（精度の方針）は、9章の項目4に依存する。
10. **`index.ts` の入口の切り替え**: 7章の PR 6 で一度に切り替える案は、旧 API と新 API の共存を内部に限る前提である。実装計画 3 章の「main に PR ごとに squash マージする」が、公開 API を段階的に変えることを許すのか、変更が完了するまで公開 API を保つことを求めるのかが、文面からは読み切れない。
