import type { AggregateId } from "../aggregate-id";
import type { EventEnvelope } from "../event-envelope";
import type { EventStore } from "../event-store";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import { decodeEventEnvelope } from "./bigtable-envelope";
import type { BigtableEventFields } from "./bigtable-event-fields";
import { guarded } from "./bigtable-guarded";
import { readHead } from "./bigtable-head";
import {
  chain,
  column,
  EVENT_ENVELOPE,
  FAMILY_EVENT,
  latestCell,
} from "./bigtable-request-parts";
import { cellValue } from "./bigtable-row";
import { journalRange, journalSeqNr } from "./bigtable-row-keys";
import {
  aggregatePrefixOf,
  type BigtableStoreResources,
} from "./bigtable-store-resources";
import { validateSeqNr } from "./seq-nr-validation";
import { validateAggregateId } from "./validated-event-store";

const NANOS_PER_MILLI = BigInt(1000000);

export function createBigtableGetEvents<PE, PS>(
  resources: BigtableStoreResources<PE, PS>,
): EventStore<PE, PS>["getEventsByIdSinceSeqNr"] {
  return async (aggregateId, seqNr) => {
    const validatedId = validateAggregateId(aggregateId);
    if (validatedId.type === "err") return validatedId;
    const start = validateSeqNr(seqNr);
    if (start.type === "err") return start;
    const aid = `${validatedId.value.typeName}-${validatedId.value.value}`;
    return guarded("event journal query failed", async () => {
      const prefix = aggregatePrefixOf(resources, aid);
      // BT-9: 最初に head の h と末尾のイベントを取得し、以後はその値を使う。
      const head = await readHead(resources.head, prefix, aid);
      await resources.hooks?.afterReadHead?.("events");
      if (head === undefined) return Result.ok([]);
      const from = Math.max(1, start.value);
      const h = head.seqNr;
      if (from > h) return Result.ok([]);
      const stored: BigtableEventFields[] = [];
      if (from < h)
        stored.push(
          ...(await readJournalEvents(resources, prefix, aid, from, h)),
        );
      stored.push(head.lastEvent);
      const events: EventEnvelope<PE>[] = [];
      for (const fields of stored) {
        const restored = restore(
          fields,
          validatedId.value,
          resources.settings.eventSerializer,
        );
        if (restored.type === "err") return restored;
        events.push(restored.value);
      }
      return Result.ok(events);
    });
  };
}

/** journal の [start, h) を読み切る。対象の範囲に欠番があれば、短い結果を成功とせず保存先エラーにする（BT-10）。 */
async function readJournalEvents<PE, PS>(
  resources: BigtableStoreResources<PE, PS>,
  prefix: Uint8Array,
  aid: string,
  start: number,
  h: number,
): Promise<readonly BigtableEventFields[]> {
  const [rangeStart, rangeEnd] = journalRange(prefix, start, h);
  const rows = await resources.journal.readRange(
    rangeStart,
    rangeEnd,
    chain([column(FAMILY_EVENT, EVENT_ENVELOPE), latestCell()]),
  );
  const gap = () =>
    EventStoreError.storage("the journal has a gap in the requested range");
  if (rows.length !== h - start) throw gap();
  return rows.map((row, index) => {
    const expected = start + index;
    if (journalSeqNr(prefix, row.key) !== expected) throw gap();
    const bytes = cellValue(row, FAMILY_EVENT, EVENT_ENVELOPE);
    if (bytes === undefined)
      throw EventStoreError.storage("a journal row has no event envelope");
    const fields = decodeEventEnvelope(bytes);
    if (fields.aid !== aid || fields.seqNr !== expected)
      throw EventStoreError.storage(
        "a journal row holds an envelope of another aid or seq_nr",
      );
    return fields;
  });
}

function restore<PE>(
  fields: BigtableEventFields,
  aggregateId: AggregateId,
  serializer: BigtableStoreResources<
    PE,
    unknown
  >["settings"]["eventSerializer"],
): Result<EventEnvelope<PE>, EventStoreError> {
  // ナノ秒からミリ秒へは切り捨てる（負の値は負の無限大方向）。
  const nanos = fields.occurredAtNs;
  const millis =
    nanos / NANOS_PER_MILLI -
    (nanos % NANOS_PER_MILLI < BigInt(0) ? BigInt(1) : BigInt(0));
  try {
    const payload = serializer.deserialize(
      new Uint8Array(fields.payload),
      fields.manifest,
    );
    return Result.ok(
      Object.freeze({
        aggregateId,
        seqNr: fields.seqNr,
        occurredAt: new Date(Number(millis)),
        manifest: fields.manifest,
        payload,
      }),
    );
  } catch (cause) {
    return Result.err(
      EventStoreError.serialization(
        "deserialize",
        "event payload deserialization failed",
        cause,
      ),
    );
  }
}
