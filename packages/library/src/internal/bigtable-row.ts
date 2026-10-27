import type { BigtableCell } from "./bigtable-cell";

/** ReadRows の応答から組み立てた、完成した 1 行。 */
export type BigtableRow = Readonly<{
  key: Uint8Array;
  cells: readonly BigtableCell[];
}>;

/** 列ファミリと列修飾子が一致する最初のセルの値。なければ undefined。 */
export function cellValue(
  row: BigtableRow,
  family: string,
  qualifier: string,
): Uint8Array | undefined {
  const wanted = Buffer.from(qualifier, "utf8");
  return row.cells.find(
    (cell) =>
      cell.family === family && Buffer.from(cell.qualifier).equals(wanted),
  )?.value;
}
