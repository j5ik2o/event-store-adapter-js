## EventStore が利用する Cloud Spanner のテーブル構成

Spanner adapter は GoogleSQL の `journal` と `snapshot` を使います。
`Database` のライフサイクルは呼び出し側が管理し、`EventStore.createSpanner(...)` に渡します。

```sql
CREATE TABLE journal (
  shard_id INT64 NOT NULL,
  aggregate_id STRING(MAX) NOT NULL,
  sequence_number INT64 NOT NULL,
  payload BYTES(MAX) NOT NULL,
  occurred_at TIMESTAMP NOT NULL
) PRIMARY KEY (shard_id, aggregate_id, sequence_number);

CREATE TABLE snapshot (
  shard_id INT64 NOT NULL,
  aggregate_id STRING(MAX) NOT NULL,
  sequence_number INT64 NOT NULL,
  version INT64 NOT NULL,
  payload BYTES(MAX) NOT NULL,
  updated_at TIMESTAMP NOT NULL
) PRIMARY KEY (shard_id, aggregate_id, sequence_number);
```

### Journal

`journal` はすべてのイベントを保存します。`occurred_at` には `event.occurredAt` を保存します。
イベントの読み取りは `(shard_id, aggregate_id)` で絞り込み、`sequence_number ASC` で取得します。

### Snapshot

`snapshot` は最新スナップショットと、必要に応じて保持用スナップショットコピーを保存します。

| `sequence_number` | 意味 |
|:--|:--|
| `0` | 最新スナップショット。読み取り対象です。 |
| `> 0` | `keepSnapshotCount` 向けの保持用スナップショットコピーです。 |

`updated_at` には、対応する `event.occurredAt` を保存します。
event-only update では、最新スナップショットの `payload` は置き換えず、`version` だけを進めます。

保持処理は hard-delete のみです。`keepSnapshotCount` が設定されている場合、
`sequence_number > 0` の行を `sequence_number` の新しい順で保持し、古い行を削除します。
`sequence_number = 0` の最新スナップショットは保持数に含めず、削除対象にもなりません。

### Change Streams

Change Streams は初期 adapter の scope 外です。将来 downstream integration を追加する場合は、
すべてのドメインイベントを集約の sequence 単位で観測できるように、`snapshot` ではなく `journal` を監視対象にしてください。
