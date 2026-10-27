import type { BigtableChunk } from "./bigtable-chunk";

/** ReadRows の応答 1 つ分。 */
export type BigtableReadRowsResponse = Readonly<{
  chunks?: readonly BigtableChunk[] | null;
}>;
