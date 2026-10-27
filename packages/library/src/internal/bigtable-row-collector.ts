import { EventStoreError } from "../event-store-error";
import type { BigtableCell } from "./bigtable-cell";
import type { BigtableChunk } from "./bigtable-chunk";
import type { BigtableRow } from "./bigtable-row";

const invalid = (message: string) =>
  EventStoreError.storage(`invalid ReadRows response: ${message}`);

const bytesOf = (value: Uint8Array | string | null | undefined): Buffer =>
  value === null || value === undefined
    ? Buffer.alloc(0)
    : Buffer.from(value as Uint8Array);

/**
 * ReadRows のチャンクから行を組み立てる（BT-10）。完成した行（commitRow）だけを返す。
 * チャンクは順に届き、列ファミリ・列修飾子・値の続きを前のチャンクから引き継ぐので、
 * このクラスは 1 回の流れのあいだだけ生きる局所的な可変状態を持つ。
 * エミュレーターは同じ行の 2 つ目以降のチャンクにも行キーを付けるので、同じ行キーは同じ行の続きとして扱う。
 */
export class RowCollector {
  private rowKey: Buffer | undefined;
  private cells: BigtableCell[] = [];
  private family = "";
  private qualifier: Buffer = Buffer.alloc(0);
  private pending:
    | {
        family: string;
        qualifier: Buffer;
        timestampMicros: number;
        parts: Buffer[];
      }
    | undefined;

  /** チャンクを 1 つ取り込む。行が完成したら、その行を返す。 */
  push(chunk: BigtableChunk): BigtableRow | undefined {
    if (chunk.resetRow === true) {
      // サーバーが途中の行を取り消した。後で同じ行が読み直される。
      this.discardPartialRow();
      return undefined;
    }
    const rowKey = this.acceptRowKey(bytesOf(chunk.rowKey));
    const value = bytesOf(chunk.value);
    const valueSize = chunk.valueSize ?? 0;
    const timestampMicros = Number(chunk.timestampMicros ?? 0);
    const carriesCellData =
      this.pending !== undefined ||
      chunk.familyName != null ||
      chunk.qualifier != null ||
      value.length > 0 ||
      valueSize !== 0 ||
      timestampMicros !== 0;
    if (chunk.familyName != null) this.family = chunk.familyName.value ?? "";
    if (chunk.qualifier != null)
      this.qualifier = bytesOf(chunk.qualifier.value);
    if (carriesCellData) this.acceptCellData(value, valueSize, timestampMicros);
    return chunk.commitRow === true ? this.commitRow(rowKey) : undefined;
  }

  /** 未完成の行（または未完成のセル）を抱えているか。 */
  hasPartialRow(): boolean {
    return this.rowKey !== undefined || this.pending !== undefined;
  }

  private discardPartialRow(): void {
    this.rowKey = undefined;
    this.cells = [];
    this.pending = undefined;
  }

  /** 現在の行のキーを返す。新しい行なら始める。 */
  private acceptRowKey(rowKey: Buffer): Buffer {
    if (this.rowKey !== undefined) {
      if (rowKey.length > 0 && !rowKey.equals(this.rowKey))
        throw invalid(
          "a new row started before the previous row was completed",
        );
      return this.rowKey;
    }
    if (rowKey.length === 0) throw invalid("a chunk arrived without a row key");
    this.rowKey = rowKey;
    this.cells = [];
    this.family = "";
    this.qualifier = Buffer.alloc(0);
    this.pending = undefined;
    return rowKey;
  }

  private acceptCellData(
    value: Buffer,
    valueSize: number,
    timestampMicros: number,
  ): void {
    if (this.pending === undefined) {
      if (this.family === "")
        throw invalid("a cell arrived before its column family");
      this.pending = {
        family: this.family,
        qualifier: this.qualifier,
        timestampMicros,
        parts: [],
      };
    }
    this.pending.parts.push(value);
    // 値の続きがあるあいだは valueSize が 0 でない。最後のチャンクで 0 になる。
    if (valueSize === 0) {
      this.cells.push(
        Object.freeze({
          family: this.pending.family,
          qualifier: this.pending.qualifier,
          timestampMicros: this.pending.timestampMicros,
          value: Buffer.concat(this.pending.parts),
        }),
      );
      this.pending = undefined;
    }
  }

  private commitRow(rowKey: Buffer): BigtableRow {
    if (this.pending !== undefined)
      throw invalid("a row was committed in the middle of a cell");
    const row = Object.freeze({
      key: rowKey,
      cells: Object.freeze(this.cells),
    });
    this.rowKey = undefined;
    this.cells = [];
    return row;
  }
}
