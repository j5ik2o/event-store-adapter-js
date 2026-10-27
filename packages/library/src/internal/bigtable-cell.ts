/** 組み立てた 1 つのセル。 */
export type BigtableCell = Readonly<{
  family: string;
  qualifier: Uint8Array;
  timestampMicros: number;
  value: Uint8Array;
}>;
