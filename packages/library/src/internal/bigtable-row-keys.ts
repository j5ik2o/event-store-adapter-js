import { fnv1a64 } from "./fnv1a64";

/** 設定行のキー。データ行のキーは最小でも 11 バイトなので、この 1 バイトと完全一致しない。 */
export const CONFIG_ROW_KEY: Uint8Array = Buffer.from([0x00]);

/**
 * `P(aid) = H ‖ L16(len(A)) ‖ A`。head の行キーは `P`、journal の行キーは `P ‖ U64BE(seq_nr)`。
 * 長さを含めるので、ハッシュが衝突しても別の aid の `P` は前方一致にならない（BT-3）。
 * aid の長さは T-12 で 1024 バイト以下に保証されているので、16bit に収まる。
 */
export function aggregatePrefix(
  aid: string,
  hash: bigint = fnv1a64(aid),
): Uint8Array {
  const aidBytes = Buffer.from(aid, "utf8");
  const prefix = Buffer.alloc(8 + 2 + aidBytes.length);
  prefix.writeBigUInt64BE(hash, 0);
  prefix.writeUInt16BE(aidBytes.length, 8);
  aidBytes.copy(prefix, 10);
  return prefix;
}

/** `P ‖ U64BE(seq_nr)`。バイト列の辞書順は seq_nr の数値の順と一致する（BT-4）。 */
export function journalRowKey(prefix: Uint8Array, seqNr: number): Uint8Array {
  const suffix = Buffer.alloc(8);
  suffix.writeBigUInt64BE(BigInt(seqNr));
  return Buffer.concat([prefix, suffix]);
}

/** journal の範囲 `[P ‖ U64BE(start), P ‖ U64BE(endExclusive))`。終了は排他的である。 */
export function journalRange(
  prefix: Uint8Array,
  start: number,
  endExclusive: number,
): readonly [Uint8Array, Uint8Array] {
  return [
    journalRowKey(prefix, start),
    journalRowKey(prefix, endExclusive),
  ] as const;
}

/** journal の行キーから seq_nr を取り出す。`P ‖ U64BE(seq_nr)` の形でなければ undefined。 */
export function journalSeqNr(
  prefix: Uint8Array,
  rowKey: Uint8Array,
): number | undefined {
  const key = Buffer.from(rowKey);
  const head = Buffer.from(prefix);
  if (
    key.length !== head.length + 8 ||
    !key.subarray(0, head.length).equals(head)
  ) {
    return undefined;
  }
  const value = key.readBigUInt64BE(head.length);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}
