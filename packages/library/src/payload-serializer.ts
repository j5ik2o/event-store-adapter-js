/**
 * ペイロードだけを変換する同期シリアライザ。
 * 失敗は例外で通知し、保存先が捕捉して操作と原因を持つエラーへ分類する。
 */
export type PayloadSerializer<P> = {
  serialize(payload: P): Uint8Array;
  deserialize(bytes: Uint8Array, manifest: string): P;
};

export namespace PayloadSerializer {
  /** 既定のJSON実装。manifestを解釈せず、ドメインのスキーマ検査は行わない。 */
  export function json<P = unknown>(): PayloadSerializer<P> {
    return Object.freeze({
      serialize(payload: P): Uint8Array {
        const json = JSON.stringify(payload, (_key, value: unknown) => {
          if (
            value === undefined ||
            typeof value === "function" ||
            typeof value === "bigint" ||
            typeof value === "symbol" ||
            (typeof value === "number" && !Number.isFinite(value))
          ) {
            throw new TypeError("payload contains a value unsupported by JSON");
          }
          return value;
        });
        return new TextEncoder().encode(json);
      },
      deserialize(bytes: Uint8Array, _manifest: string): P {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      },
    });
  }
}

Object.freeze(PayloadSerializer);
