import type { AggregateId } from "../aggregate-id";
import { fnv1a64 } from "./fnv1a64";

/** Spanner の主キーの前半。ハッシュは 8 バイトのビッグエンディアンで、aid は完全一致で比べる。 */
export function spannerAggregateKey(
  id: AggregateId,
): Readonly<{ hashPrefix: Buffer; aid: string }> {
  const aid = `${id.typeName}-${id.value}`;
  const hashPrefix = Buffer.alloc(8);
  hashPrefix.writeBigUInt64BE(fnv1a64(aid));
  return Object.freeze({ hashPrefix, aid });
}
