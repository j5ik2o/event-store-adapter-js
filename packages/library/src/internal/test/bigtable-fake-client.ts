import { Readable } from "node:stream";
import type { Bigtable } from "@google-cloud/bigtable";

export type FakeRequestConfig = Readonly<{
  client: string;
  method: string;
  reqOpts: Record<string, unknown>;
  gaxOpts?: { otherArgs?: { headers?: Record<string, string> } };
  retryOpts?: { retries?: number };
}>;

export type FakeUnaryReply = Readonly<{
  error?: unknown;
  response?: Record<string, unknown> | null;
}>;

/** 流れに乗せる値。Error は、そこに達したときに流れを失敗させる。 */
export type FakeStreamItem = object | Error;

export type FakeBigtable = Bigtable & { calls: FakeRequestConfig[] };

/** 実サービスにもエミュレーターにも接続しない、`Bigtable#request` だけを持つ偽のクライアント。 */
export function fakeBigtable(
  options: Readonly<{
    appProfileId?: string;
    unary?: (config: FakeRequestConfig, attempt: number) => FakeUnaryReply;
    stream?: (
      config: FakeRequestConfig,
      attempt: number,
    ) => readonly FakeStreamItem[];
  }> = {},
): FakeBigtable {
  const calls: FakeRequestConfig[] = [];
  const counts = new Map<string, number>();
  const attemptOf = (method: string) => {
    const attempt = counts.get(method) ?? 0;
    counts.set(method, attempt + 1);
    return attempt;
  };
  const request = (
    config: FakeRequestConfig,
    callback?: (
      error: unknown,
      response?: Record<string, unknown> | null,
    ) => void,
  ) => {
    calls.push(config);
    const attempt = attemptOf(config.method);
    if (callback !== undefined) {
      const reply = options.unary?.(config, attempt) ?? {};
      setImmediate(() => callback(reply.error, reply.response));
      return undefined;
    }
    const items = options.stream?.(config, attempt) ?? [];
    return Readable.from(
      (async function* () {
        for (const item of items) {
          if (item instanceof Error) throw item;
          yield item;
        }
      })(),
    );
  };
  return {
    projectName: "projects/fake-project",
    ...(options.appProfileId === undefined
      ? {}
      : { appProfileId: options.appProfileId }),
    request,
    calls,
  } as unknown as FakeBigtable;
}

const chunk = (over: Record<string, unknown>): Record<string, unknown> => ({
  rowKey: Buffer.alloc(0),
  familyName: null,
  qualifier: null,
  timestampMicros: "0",
  value: Buffer.alloc(0),
  valueSize: 0,
  commitRow: false,
  ...over,
});

/** 完成した 1 行を表す ReadRows の応答。cells は [列ファミリ, 列修飾子, 値] の並び。 */
export function rowResponse(
  rowKey: Uint8Array,
  cells: readonly (readonly [string, string, Uint8Array | string])[],
): { chunks: Record<string, unknown>[] } {
  return {
    chunks: cells.map(([family, qualifier, value], index) =>
      chunk({
        rowKey: index === 0 ? Buffer.from(rowKey) : Buffer.alloc(0),
        familyName: { value: family },
        qualifier: { value: Buffer.from(qualifier) },
        value: Buffer.from(value),
        commitRow: index === cells.length - 1,
      }),
    ),
  };
}
