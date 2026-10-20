# JavaScriptの封筒APIへの移行

旧JavaScript 4.x APIと、旧DynamoDB 2表配置または旧Spanner 2表配置を使うアプリケーション向けの手順です。新公開APIは新しい配置だけを読みます。DynamoDBは3表、Spannerは `event-store-adapter-js/spanner` 入口の5表です。DynamoDBの手順を先に説明します。Spannerは [Spanner 4.x から v5 の Spanner へ](#spanner-4x-から-v5-の-spanner-へ) を参照してください。利用者がexportと書き直しを行う手順であり、移行ツールは提供しません。Rustの移行ツールはこのJavaScript配置へ流用できません。

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

この節は、v4 の Spanner アダプタが書いたデータ（`journal` と `snapshot` の 2 テーブル。[v4 の構成](SPANNER_DATABASE_SCHEMA.ja.md#v4-4x-の-cloud-spanner-のテーブル構成移行の元) を参照）を、v5 の 5 テーブルへ移す手順です。利用者が行う手順であり、移行ツールは提供しません。この節で「確かめる」と書いた項目は、コミット `a443ef9` の v4 アダプタ（`packages/library/src/internal/spanner-event-store.ts`）の契約を読んで確かめてください。v4 の契約から決まらないことは、利用者が確かめることです。推測で決めないでください。

v4 のアダプタが書いていたもの:

- `aggregate_id` は `aggregateId.asString()` の結果です。形はアプリケーションが決めていたので、文字列だけから型名と値は復元できません。`shard_id` は、アプリケーションが差し替えられるシャード選択器が決めていました。そのため、同じ `aggregate_id` が複数の `shard_id` にあることもあり得ます。
- `payload` はイベントの直列化の出力です。既定の直列化は、イベント全体を JSON にしていました。`{ "type": event.typeName, "data": event }` の形です。manifest の列はありません。
- `occurred_at` は `TIMESTAMP` 型で、`Date.toISOString()` から書いていたので、ミリ秒の精度です。
- `sequence_number` はイベントが持つ番号です。v4 は番号が連続していることを検査していません。主キーが重複を防ぐのは、同じ `shard_id` の中だけです。
- `snapshot` では、`sequence_number = 0` の行が最新のスナップショットです。この行には、どのイベントの時点のものかという番号の列がありません。イベントだけを書いたときは、`payload` を置き換えず `version` だけを進めていました。`sequence_number > 0` の行は保持用の写しで、そのときのイベントの番号で書いていました。

手順:

1. v4 の書き手をすべて止めます。v4 のテーブル、v4 の導入版、利用者の変換器と直列化を、読み取りのために残します。
2. v5 の 5 テーブルを、**新しい接頭辞**で作ります。[SPANNER_DATABASE_SCHEMA.ja.md](SPANNER_DATABASE_SCHEMA.ja.md) の初期化の手順に従い、DDL を実行し、テーブルが空であることを確かめてから、設定の行を書きます。
3. 何かを移す前に、旧テーブルを検査します。次のクエリは例です。シャードごとではなく、テーブル全体に対して実行してください。

   欠番と重複。すべてのシャードを合わせて、番号が 1 から最大値まで欠けず、重複もない集約だけが正常です。次のクエリは、そうでない集約を返します。

   ```sql
   SELECT aggregate_id,
          COUNT(*) AS row_count,
          COUNT(DISTINCT sequence_number) AS distinct_numbers,
          MIN(sequence_number) AS min_number,
          MAX(sequence_number) AS max_number
   FROM journal
   GROUP BY aggregate_id
   HAVING MIN(sequence_number) <> 1
       OR COUNT(*) <> COUNT(DISTINCT sequence_number)
       OR COUNT(*) <> MAX(sequence_number);
   ```

   ミリ秒より細かい時刻。v4 のアダプタはこのような値を書けないので、該当する行はデータの問題です。止めて、出所を調べてください。

   ```sql
   SELECT aggregate_id, sequence_number
   FROM journal
   WHERE occurred_at <> TIMESTAMP_TRUNC(occurred_at, MILLISECOND);
   ```

   複数のシャードにまたがるキー。上の検査は、すべてのシャードを合わせて数えます。差し替えたシャード選択器が、1 つの `aggregate_id` の行を複数の `shard_id` に置いていた場合、それらの行は `asString()` が等しい別々の集約のものかもしれず、上の数え方では混ざります。次のクエリは、そのようなキーを返します。手順 4 で、そのキーのすべての行が 1 つの型名と値に復元されると確かめられない限り、検査に出たものとして扱います。

   ```sql
   SELECT aggregate_id, COUNT(DISTINCT shard_id) AS shard_count
   FROM journal
   GROUP BY aggregate_id
   HAVING COUNT(DISTINCT shard_id) > 1;
   ```

   最後のイベントを超えるスナップショットの番号。スナップショットの番号が、集約の最大のイベントの番号を超えてはいけません。

   ```sql
   SELECT s.aggregate_id, s.sequence_number
   FROM snapshot AS s
   LEFT JOIN (
     SELECT aggregate_id, MAX(sequence_number) AS max_number
     FROM journal
     GROUP BY aggregate_id
   ) AS j ON j.aggregate_id = s.aggregate_id
   WHERE j.max_number IS NULL OR s.sequence_number > j.max_number;
   ```

   どれかの検査に出た集約は移しません。欠番や重複を隠すために番号を振り直してはいけません。v5 は番号が 1 から連続することを求めるので、そのような集約は元のデータで解決してください。

4. 型名と値は、キーの文字列ではなく、旧データから復元します。それぞれのイベントを、それを書いた v4 の直列化と変換器で読み、`event.aggregateId.typeName` と `event.aggregateId.value` を取り出します。`event.aggregateId.asString()` が保存されている `aggregate_id` と一致すること、および同じ `aggregate_id` のすべての行が同じ型名と値に復元されることを確かめます。そうでなければ、そのキーは移しません。`aggregate_id` を `-` で分けて推測してはいけません。カスタムのキーの導き方を使っていた場合や、必要な情報がないデータは、その集約を移しません。
   - v4 の型名には `-` が含まれることがありますが、v5 では使えません。利用者が用意する対応表で置き換え、その型のすべての集約に同じ対応を適用します。
   - 新しい ID は `AggregateId.of` で作ります。UTF-8 で 1024 バイトを超える `aid` は `contract-violation` のエラーで返るので、書き込む前に解決します。
   - 別々の旧キーから同じ新しい `aid` が作られないことを確かめます。型名を置き換えた後に衝突することがあります。
5. イベントを変換します。v4 の payload にはイベント全体が入っています（既定の直列化では `{ type, data }`）。メタデータも中にあります。そこからドメインの値だけを取り出し、v5 の payload にします。v4 は manifest を保存していないので、新しい payload の形に合わせて利用者が決めます。既定の直列化では、`type` に `event.typeName` が入っていました。
6. 時刻を変換します。v4 の `TIMESTAMP` はミリ秒の精度です。`Date` として v5 に渡すと、v5 はエポックからのミリ秒から計算したナノ秒（`INT64`）で保存し、ミリ秒より下は 0 になります。v4 が保存していなかった精度は戻りません。元の時刻がナノ秒の精度を持っていた証拠にもなりません。
7. スナップショットの番号を決めます。v4 の最新の行（`sequence_number = 0`）にはイベントの番号が記録されておらず、イベントだけを書いた後では、`payload` が最新のイベントより古い状態です。番号は、確かめられた情報だけで決めます。一例は、保持用の写し（`sequence_number > 0`）のうち、`payload` のバイト列が最新の行と等しいものがちょうど 1 つだけある場合の、その写しの番号です。もう一例は、利用者のドメインが保証する番号です。決めた番号が最大のイベントの番号以下であることを確かめます。決められないときは、スナップショットを移さず、イベントだけを移します。`version` は移しません。保持用の写しは `esa_snapshot_history` へ移しません。v5 は、手順 8 で書くスナップショットを含め、スナップショットの書き込みのたびに、自分の規則で履歴を作ります。
8. v5 の API で書き込みます。`SpannerEventStore.create` でストアを開き、[DynamoDB の手順](#書き直しと照合) の `rewrite` の補助関数を、確かめた順に、集約を 1 つずつ使います。手順 3 で旧番号が 1 から連続していることを確かめたので、補助関数の `index + 1` は旧番号と等しくなり、番号は振り直されません。集約のスナップショットは、手順 7 で番号を決めたレコードに付けます。v5 の head は書き込みのたびに更新され、集約の最後の書き込みの後には、最大の番号とそのイベントの封筒を持ちます。payload がドメインのオブジェクトなら、`SpannerEventStore.create` に直列化を 2 つ渡してください。
9. 読み戻して照合します。集約ごとに、イベントの件数と番号が 1 から連続していること、`headSeqNr` が最大の番号と一致すること、スナップショットの番号・manifest・payload・発生時刻・復元したドメインの状態を確かめます。復元は、スナップショットの番号＋1、スナップショットなしなら 1 から始めます。
10. この版は変更フィードを提供しません。v4 のデータに依存した後段の処理やリードモデルがあるときは、切り替える前に、作り直し方を決めてください。
11. アプリケーションを新しい接頭辞へ切り替えます。v4 のテーブルは、片付けてよいことを確かめるまで残します。

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
