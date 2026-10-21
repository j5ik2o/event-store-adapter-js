# JavaScriptの封筒APIへの移行

旧JavaScript 4.x APIと、旧DynamoDB 2表配置または旧Spanner 2表配置を使うアプリケーション向けの手順です。新公開APIは新しい配置だけを読みます。DynamoDBは3表、Spannerは `event-store-adapter-js/spanner` 入口の5表です。DynamoDBの手順を先に説明します。Spannerは [Spanner 4.x から v5 の Spanner へ](#spanner-4x-から-v5-の-spanner-へ) を参照してください。DynamoDBの手順は、利用者がexportと書き直しを行う手順であり、移行ツールは提供しません。Spannerの旧配置には、移行関数 `migrateV4Spanner` があります。Rustの移行ツールはこのJavaScript配置へ流用できません。

## 準備と読み出し

1. 旧書き込みを止めるか、exportの確定点と切替時間を決めます。読み取り用に旧アプリケーション、正確な導入版、domain converter/serializer、旧表を保持します。
2. [DATABASE_SCHEMA.ja.md](DATABASE_SCHEMA.ja.md) に従い、新しい名前でjournal・snapshot・headの3表、履歴GSI、必要なTTL設定を作ります。
3. 導入済みの旧4.xを使う別プロセスで、旧APIから集約ごとの全イベントを番号1から読み、移すsnapshotも読みます。domain値と確認済みmetadataをexportします。snapshot番号からだけ読むと、全件書き直しに必要な履歴が欠けます。
4. 利用者の変換コードで、封筒のmetadataとevent・aggregateのpayloadを分離します。旧集約ごとに有効な `AggregateId` を明示対応させます。新版の `typeName` に `-` は使えません。payloadのスキーマと `manifest` を決め、JSON値以外のdomain値を使う場合は `PayloadSerializer` を用意します。
5. 元のイベント順を確認し、旧番号から新しい連続番号1以降への対応表を作ります。snapshotはその状態を表すイベントへ対応させ、そのイベントの新番号を使います。この対応をexport記録に残します。

旧readerと新writerは、それぞれのパッケージを導入した別プロセスで動かし、利用者が定めたexportデータを受け渡します。新版ライブラリは旧APIのaliasや旧形式readerを提供しません。

## 時刻の変換前に確認すること

実際の旧パッケージ、serializer、保存属性、exportしたpayloadのmetadataを確認してください。数値時刻の単位や、完全なエポック値が入っていることを推測してはいけません。旧JavaScriptの一部の書込経路はUTCのミリ秒成分だけを保存していました。成分だけから元の時点は復元できません。exportに別の確認済み時刻があれば使い、必要な情報が欠ける場合は移行データの問題として対応してください。時点や精度を創作しないでください。

新版はミリ秒精度の `Date` を受けます。失われたミリ秒未満の桁を補ったり、数値の大きさから元単位を推測したりしません。確認できた精度損失はexportへ記録します。

## 書き直しと照合

writerプロセスで新版を使い、新しい表を開き、確認済みの順に集約ごとに書き込みます。次のhelperの入力は、**利用者が既にmetadataとpayloadを分離し、確認したデータ**です。新番号を付与し、各イベントを1回だけ書きます。対応するsnapshotは同じイベントと同じ番号で書きます。

```typescript
import {
  EventEnvelope, SnapshotEnvelope,
  type AggregateId, type EventStore, type EventStoreError, type Result,
} from "event-store-adapter-js";

function unwrap<T>(result: Result<T, EventStoreError>): T {
  if (result.type === "err") throw new Error(result.error.message, { cause: result.error });
  return result.value;
}

// Caller-prepared records for one aggregate, in the confirmed original order.
type Converted = {
  occurredAt: Date;
  manifest: string;
  payload: unknown;
  snapshot?: { manifest: string; aggregate: unknown };
};

async function rewrite(
  target: EventStore, id: AggregateId, records: readonly Converted[],
): Promise<void> {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const seqNr = index + 1;
    const event = unwrap(EventEnvelope.create({
      aggregateId: id, seqNr, occurredAt: record.occurredAt,
      manifest: record.manifest, payload: record.payload,
    }));
    if (record.snapshot === undefined) {
      unwrap(await target.persistEvent(event));
    } else {
      const snapshot = unwrap(SnapshotEnvelope.create({
        seqNr, manifest: record.snapshot.manifest,
        aggregate: record.snapshot.aggregate,
      }));
      unwrap(await target.persistEventAndSnapshot(event, snapshot));
    }
  }
  const events = unwrap(await target.getEventsByIdSinceSeqNr(id, 1));
  const latest = unwrap(await target.getLatestSnapshotById(id));
  if (events.length !== records.length ||
      events.some((event, index) => event.seqNr !== index + 1) ||
      (latest?.headSeqNr ?? 0) !== records.length) {
    throw new Error("rewrite count or final sequence mismatch");
  }
}
```

既定JSONを使う場合、`records` のpayloadはJSON値です。任意domain値を使う場合は、target生成時に両serializerを設定してください。

exportと書直し結果のイベント件数、連続番号、終端head番号、metadata、復元したpayloadを照合します。snapshot番号＋1、snapshotなしなら1から集約を復元し、domain状態も比較してください。履歴保持で古いsnapshotは除去され得るため、残るsnapshot件数だけで現在状態を判定しません。

照合後にアプリケーションを新公開入口と新しい表へ切り替えます。旧exportと旧表は利用者が清掃を確認するまで保持します。

## Spanner 4.x から v5 の Spanner へ

この節は、v4 の Spanner アダプタが書いたデータ（`journal` と `snapshot` の 2 テーブル。[v4 の構成](SPANNER_DATABASE_SCHEMA.ja.md#v44xの-cloud-spanner-のテーブル構成移行の元) を参照）を、`event-store-adapter-js/spanner` の `migrateV4Spanner` で v5 の 5 テーブルへ移す手順です。この関数は v4 の 2 テーブルを読み、全行を検査し、拒む理由が 1 件もないときだけ書きます。復元の関数を書くときは、コミット `a443ef9` の v4 アダプタ（`packages/library/src/internal/spanner-event-store.ts`）の契約を読んでください。

v4 のアダプタが書いていたもの:

- `aggregate_id` は `aggregateId.asString()` の結果です。形はアプリケーションが決めていたので、文字列だけから型名と値は復元できません。関数は `-` で分けて推測しません。`shard_id` は、アプリケーションが差し替えられるシャード選択器が決めていました。そのため、同じ `aggregate_id` が複数の `shard_id` にあることもあり得ます。
- `payload` はイベントの直列化の出力です。既定の直列化は、イベント全体を JSON にしていました。`{ "type": event.typeName, "data": event }` の形です。manifest の列はありません。
- `occurred_at` は `TIMESTAMP` 型で、`Date.toISOString()` から書いていたので、ミリ秒の精度です。
- `sequence_number` はイベントが持つ番号です。v4 は番号が連続していることを検査していません。主キーが重複を防ぐのは、同じ `shard_id` の中だけです。
- `snapshot` では、`sequence_number = 0` の行が最新のスナップショットです。この行には、どのイベントの時点のものかという番号の列がありません。イベントだけを書いたときは、`payload` を置き換えず `version` だけを進めていました。`sequence_number > 0` の行は保持用の写しです。`version` と保持用の写しは v5 へ移しません。

手順:

1. v4 の書き手をすべて止めます。v4 のテーブル、v4 の導入版、利用者の変換器と直列化を、読み取りのために残します。この関数は v4 のテーブルを変更しません。
2. v5 の 5 テーブルを、**新しい接頭辞**で作り、設定の行を書きます。[SPANNER_DATABASE_SCHEMA.ja.md](SPANNER_DATABASE_SCHEMA.ja.md) の初期化の手順に従ってください。関数は、テーブルや設定の行を作りません。初期化されていない移行先、すでに行がある移行先、v4 のテーブル名が移行先のテーブル名と重なる場合は、拒みます。
3. `restoreEvent` を書きます。v4 の journal の 1 行（`aggregateId`、`shardId`、`sequenceNumber`、`payload`、`occurredAt`）を受け取り、型名・値・manifest・v5 の payload を返します。復元できない行は、理由の文字列を返します。その行を書いた v4 の直列化と変換器を使ってください。v4 には manifest がないので、新しい payload の形に合わせて決めます。

   ```ts
   import { migrateV4Spanner } from "event-store-adapter-js/spanner";

   const restoreEvent = (row) => {
     // v4 の既定の直列化: data がイベント全体の { type, data }
     const stored = JSON.parse(new TextDecoder().decode(row.payload));
     const event = v4Converter(stored.data); // 利用者の v4 の変換器
     if (event.aggregateId.asString() !== row.aggregateId) {
       return { type: "err", error: "aggregate_id がイベントと一致しません" };
     }
     return {
       type: "ok",
       value: {
         typeName: event.aggregateId.typeName,
         value: event.aggregateId.value,
         manifest: stored.type,
         payload: toDomainValue(event), // メタデータを除いたドメインの値だけ
       },
     };
   };
   ```

4. v4 の型名に `-` がある場合は、`typeNameMapping`（`Map`）を用意します。v5 は型名の `-` を許しません。関数は、`-` を含む型名だけを対応表で置き換えます。次のものは拒みます。対応表に項目がない型名、置き換え後にも `-` が残るもの、UTF-8 で 1024 バイトを超える新しい `aid`、異なる 2 つの `aggregate_id` から同じ新しい `aid` ができる場合。
5. 必要なら `restoreSnapshot` を書きます。v4 のスナップショットの行を持つ集約ごとに 1 回呼ばれ、`{ aggregateId, maxSeqNr, latest, retained }` を受け取ります。v5 の `SnapshotEnvelope` を返すか、移さないときは `undefined` を返します。v4 の最新の行（`sequence_number = 0`）には、イベントの番号がなく、イベントだけを書いた後は `payload` が最新のイベントより古くなっています。番号は、確かめた情報からだけ決めてください。たとえば、保持用の写しのうち `payload` のバイト列が最新の行と等しいものがちょうど 1 件のとき、その番号を使う方法があります。番号は 1 以上、`maxSeqNr` 以下です。この関数を渡さない場合や `undefined` を返した場合は、その集約はイベントだけを移します。
6. 関数を実行します。

   ```ts
   const result = await migrateV4Spanner({
     database,
     v4Tables: { journal: "journal", snapshot: "snapshot" },
     target: { tablePrefix: "esa_v5" }, // SpannerEventStore.create の入力から database を除いたもの
     typeNameMapping: new Map([["order-item", "OrderItem"]]),
     restoreEvent,
     restoreSnapshot,
   });
   ```

7. 結果を読みます。結果は `Result` で、成功の値は報告です。
   - `aggregates`、`events`、`snapshots` は、移した件数です。
   - `eventsOnlyAggregates` は、スナップショットを移さずにイベントだけを移した v4 の `aggregate_id` の一覧です。切り替える前に、それでよいかを判断してください。

   失敗のときは、`error.type` で分かります。
   - `rejected`: 検査が拒み、**何も書いていません**。`rejections` に、拒んだ項目ごとに `table`、`aggregateId`、`shardId`、`sequenceNumber`、`reason` が入ります。拒む理由は、番号の欠番や重複、1 つの `aggregate_id` の行が別の型名や値に復元される場合、ミリ秒より細かい時刻、`restoreEvent` が拒んだ行、使えない型名や `aid`、最大値を超える、またはイベントのないスナップショット番号、journal に行がない集約の snapshot の行、移行先が使えない状態、です。原因を元のデータで直して、もう一度実行してください。欠番や重複を隠すために、イベントの番号を振り直さないでください。
   - `error`: 保存先の失敗です。それまでに書いた件数が `progress` に入ります。
   - `verification-failed`: 書いたあとの読み戻しが計画と食い違いました。`mismatches` に集約と理由が入ります。

   関数は、v4 の 2 テーブルと移行先の状態を 1 つの strong の読み取り専用トランザクションで読むので、検査と書き込みは同じデータを使います。書いた後は、集約ごとに公開 API で読み戻し、イベントの数、番号が 1 から連続していること、`headSeqNr` が最大値と等しいこと、スナップショットの番号を照合します。

   v4 の 2 テーブルを 1 つの strong の読み取りで全件メモリに読み、payload を複製します。そのため、v4 のテーブルの payload の合計のおよそ 2 倍以上のメモリが必要です。
8. この版には変更フィードがありません。v4 のデータに依存する下流の処理や読み取りモデルがある場合は、切り替える前に作り直す方法を決めてください。
9. 関数が成功の報告を返してから、アプリケーションを新しい接頭辞へ切り替えます。v4 のテーブルは、片付けてよいと確かめるまで残します。

部分的な移行と回復: 関数は、公開 API を使って、新しい `aid` の昇順に、集約ごとに、イベント 1 件につき 1 つのトランザクションで書きます。書き込みを始めた後で保存先の失敗（`error`）や読み戻しの食い違い（`verification-failed`）が起きると、すでに書いた行は移行先に残ります。関数は巻き戻しません。検査は書き込みの前に行うので、`rejected` のときは移行先に何も残りません。部分的な移行から回復するには、その移行先をそのまま使わないでください。行があるので、次の実行は拒まれます。5 テーブルを作り直す（または別の新しい接頭辞で作る）、もう一度初期化する、同じ入力で関数を再実行する、の順に行います。v4 のテーブルは変わらないので、何度でもやり直せます。

## APIの対応

| 旧API・設定 | 新契約 |
| --- | --- |
| `EventStore<Id, Aggregate, Event>` | `EventStore<EventPayload, SnapshotPayload>` |
| 永続化metadataを含むイベント・集約 | `EventEnvelope`・`SnapshotEnvelope`、payloadを分離 |
| `persistEvent(event, expectedVersion)` | `persistEvent(envelope)`、連続 `seqNr` でロック |
| `getEventsByIdSinceSequenceNumber` | `getEventsByIdSinceSeqNr`、封筒のResult |
| 最新aggregateの直接返却 | `{ headSeqNr, snapshot? }` のResult、headなしなら `undefined` |
| 同期のDynamoDB直接生成 | `await EventStore.createDynamoDB(input)`、Result |
| Memoryの直接生成 | `EventStore.createMemory(input?)`、Result |
| `eventConverter`・`snapshotConverter`・旧serializer | `eventSerializer`・`snapshotSerializer`、payload bytesとmanifest |
| `keepSnapshotCount`・`deleteTtlMillis` | `retention: { count, mode }`、TTLの `graceSeconds` は秒 |
| shard設定・journal GSI | 3表配置、journal本体を読取 |
| `isCreated`・aggregateの `version` | イベント番号とheadの条件付き更新 |
| Spanner（`EventStore.createSpanner`） | `event-store-adapter-js/spanner` の `await SpannerEventStore.create(input)`、Result。表は [SPANNER_DATABASE_SCHEMA.ja.md](SPANNER_DATABASE_SCHEMA.ja.md) に従って作成 |
