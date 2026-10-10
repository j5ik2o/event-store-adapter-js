# JavaScriptの封筒APIへの移行

旧JavaScript 4.x APIと旧DynamoDB 2表配置を使うアプリケーション向けの手順です。新公開APIは新3表配置だけを読みます。利用者がexportと書き直しを行う手順であり、移行ツールは提供しません。Rustの移行ツールはこのJavaScript配置へ流用できません。

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

照合後にアプリケーションを新公開入口と新しい表へ切り替えます。旧exportと旧表は利用者が清掃を確認するまで保持します。この変更はrelease公開、版番号変更、tag作成を行いません。

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
| Spanner | この公開入口の対象外 |
