import { EventStoreError } from "../event-store-error";
import type { BigtableEventFields } from "./bigtable-event-fields";
import type { BigtableSnapshotFields } from "./bigtable-snapshot-fields";

const FORMAT_VERSION = 0x01;
// W-6・W-9: seq_nr は 1 以上 2^53-1 以下。復元時にも範囲を守る。
const MIN_SEQ_NR = BigInt(1);
const MAX_SEQ_NR = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * 封筒の固定バイナリ形式（BT-D6a・ADR-0008）。
 * イベント: 0x01 ‖ U16(aid) ‖ aid ‖ U64(seq_nr) ‖ I64(occurred_at_ns) ‖ U32(manifest) ‖ manifest ‖ U32(payload) ‖ payload。
 * スナップショット: 0x01 ‖ U64(seq_nr) ‖ U32(manifest) ‖ manifest ‖ U32(payload) ‖ payload。
 */

export function eventEnvelopeLength(fields: BigtableEventFields): number {
  return (
    1 +
    2 +
    Buffer.byteLength(fields.aid, "utf8") +
    8 +
    8 +
    4 +
    Buffer.byteLength(fields.manifest, "utf8") +
    4 +
    fields.payload.length
  );
}

export function snapshotEnvelopeLength(fields: BigtableSnapshotFields): number {
  return (
    1 +
    8 +
    4 +
    Buffer.byteLength(fields.manifest, "utf8") +
    4 +
    fields.payload.length
  );
}

export function encodeEventEnvelope(fields: BigtableEventFields): Uint8Array {
  const aid = Buffer.from(fields.aid, "utf8");
  const manifest = Buffer.from(fields.manifest, "utf8");
  const out = Buffer.alloc(eventEnvelopeLength(fields));
  let offset = out.writeUInt8(FORMAT_VERSION, 0);
  offset = out.writeUInt16BE(aid.length, offset);
  offset += aid.copy(out, offset);
  offset = out.writeBigUInt64BE(BigInt(fields.seqNr), offset);
  offset = out.writeBigInt64BE(fields.occurredAtNs, offset);
  offset = out.writeUInt32BE(manifest.length, offset);
  offset += manifest.copy(out, offset);
  offset = out.writeUInt32BE(fields.payload.length, offset);
  Buffer.from(fields.payload).copy(out, offset);
  return out;
}

export function encodeSnapshotEnvelope(
  fields: BigtableSnapshotFields,
): Uint8Array {
  const manifest = Buffer.from(fields.manifest, "utf8");
  const out = Buffer.alloc(snapshotEnvelopeLength(fields));
  let offset = out.writeUInt8(FORMAT_VERSION, 0);
  offset = out.writeBigUInt64BE(BigInt(fields.seqNr), offset);
  offset = out.writeUInt32BE(manifest.length, offset);
  offset += manifest.copy(out, offset);
  offset = out.writeUInt32BE(fields.payload.length, offset);
  Buffer.from(fields.payload).copy(out, offset);
  return out;
}

const corrupt = (message: string) =>
  EventStoreError.storage(`invalid envelope: ${message}`);

/** 先頭から順に読む。足りないバイト数を要求したら、保存先エラーとして投げる。 */
class EnvelopeReader {
  private offset = 0;
  constructor(private readonly bytes: Buffer) {}

  take(length: number): Buffer {
    if (this.offset + length > this.bytes.length) throw corrupt("truncated");
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  version(): void {
    if (this.take(1)[0] !== FORMAT_VERSION) throw corrupt("unknown version");
  }

  seqNr(): number {
    const value = this.take(8).readBigUInt64BE(0);
    if (value < MIN_SEQ_NR || value > MAX_SEQ_NR)
      throw corrupt("seq_nr is out of range");
    return Number(value);
  }

  text(lengthBytes: 2 | 4): string {
    const buffer = this.take(lengthBytes);
    const length =
      lengthBytes === 2 ? buffer.readUInt16BE(0) : buffer.readUInt32BE(0);
    const raw = this.take(length);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch (cause) {
      throw EventStoreError.storage(
        "invalid envelope: text is not UTF-8",
        cause,
      );
    }
  }

  blob(): Uint8Array {
    const length = this.take(4).readUInt32BE(0);
    return Uint8Array.from(this.take(length));
  }

  finish(): void {
    if (this.offset !== this.bytes.length) throw corrupt("trailing bytes");
  }
}

export function decodeEventEnvelope(bytes: Uint8Array): BigtableEventFields {
  const reader = new EnvelopeReader(Buffer.from(bytes));
  reader.version();
  const aid = reader.text(2);
  const seqNr = reader.seqNr();
  const occurredAtNs = reader.take(8).readBigInt64BE(0);
  const manifest = reader.text(4);
  const payload = reader.blob();
  reader.finish();
  return Object.freeze({ aid, seqNr, occurredAtNs, manifest, payload });
}

export function decodeSnapshotEnvelope(
  bytes: Uint8Array,
): BigtableSnapshotFields {
  const reader = new EnvelopeReader(Buffer.from(bytes));
  reader.version();
  const seqNr = reader.seqNr();
  const manifest = reader.text(4);
  const payload = reader.blob();
  reader.finish();
  return Object.freeze({ seqNr, manifest, payload });
}
