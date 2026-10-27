/** ReadRows の応答のチャンク。protobuf の既定値の有無にかかわらず読めるよう、すべて省略可能とする。 */
export type BigtableChunk = Readonly<{
  rowKey?: Uint8Array | string | null;
  familyName?: Readonly<{ value?: string | null }> | null;
  qualifier?: Readonly<{ value?: Uint8Array | null }> | null;
  timestampMicros?: number | string | null;
  value?: Uint8Array | null;
  valueSize?: number | null;
  resetRow?: boolean | null;
  commitRow?: boolean | null;
}>;
