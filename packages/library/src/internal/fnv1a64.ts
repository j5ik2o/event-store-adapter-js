const OFFSET_BASIS = BigInt("0xcbf29ce484222325");
const PRIME = BigInt("0x100000001b3");
const MASK = BigInt("0xffffffffffffffff");

/** UTF-8 バイト列の FNV-1a 64（符号なし 64bit）。 */
export function fnv1a64(input: string): bigint {
  let hash = OFFSET_BASIS;
  for (const byte of Buffer.from(input, "utf8")) {
    hash = ((hash ^ BigInt(byte)) * PRIME) & MASK;
  }
  return hash;
}
