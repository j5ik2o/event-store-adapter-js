import { EventStoreError } from "../event-store-error";
import { isEventStoreError } from "./bigtable-event-store-error-guard";
import type { BigtableMutation } from "./bigtable-mutation";
import { readRows } from "./bigtable-read-rows";
import type { BigtableReadRowsResponse } from "./bigtable-read-rows-response";
import type { BigtableRequestContext } from "./bigtable-request-context";
import type { BigtableRow } from "./bigtable-row";
import type { BigtableRowFilter } from "./bigtable-row-filter";

type ClientName = "BigtableClient" | "BigtableTableAdminClient";

const ASCII_HEADER_VALUE = /^[\x20-\x7e]+$/;

/** テーブルのフルパス `projects/{p}/instances/{i}/tables/{t}`。 */
export function tablePath(
  context: BigtableRequestContext,
  tableId: string,
): string {
  return `${context.bigtable.projectName}/instances/${context.instanceId}/tables/${tableId}`;
}

const failure = (message: string, cause: unknown) =>
  isEventStoreError(cause) ? cause : EventStoreError.storage(message, cause);

/**
 * 要求を送る前の手順: accessToken → ASCII の検査 → beforeRequest → gaxOpts の組み立て。
 * トークンは要求ごとに 1 回だけ取得し、保持しない。失敗したら送らない。メッセージにトークンを含めない。
 */
async function prepare(
  context: BigtableRequestContext,
  client: ClientName,
  method: string,
): Promise<{ otherArgs?: { headers: Record<string, string> } }> {
  let authorization: string | undefined;
  if (context.accessToken !== undefined) {
    let token: unknown;
    try {
      token = await context.accessToken();
    } catch (cause) {
      throw EventStoreError.storage(
        "the access token could not be obtained",
        cause,
      );
    }
    if (typeof token !== "string" || !ASCII_HEADER_VALUE.test(token)) {
      throw EventStoreError.storage(
        "the access token cannot be used as a header value",
      );
    }
    authorization = `Bearer ${token}`;
  }
  try {
    await context.hooks?.beforeRequest?.({
      client,
      method,
      ...(authorization !== undefined ? { authorization } : {}),
    });
  } catch (cause) {
    throw failure("a request hook failed", cause);
  }
  return authorization === undefined
    ? {}
    : { otherArgs: { headers: { authorization } } };
}

async function sendUnary(
  context: BigtableRequestContext,
  client: ClientName,
  method: string,
  reqOpts: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const gaxOpts = await prepare(context, client, method);
  return new Promise((resolve, reject) => {
    // 再送は SDK に任せず、呼び出し側が 1 回だけ送る（CheckAndMutateRow は非冪等）。
    context.bigtable.request(
      { client, method, reqOpts, gaxOpts },
      (error: unknown, response?: Record<string, unknown> | null) => {
        if (error) reject(EventStoreError.storage(`${method} failed`, error));
        else resolve(response ?? {});
      },
    );
  });
}

/** データ API の対象の 1 テーブル。全ての要求に app profile を付ける（BT-1）。 */
export class BigtableTableRequests {
  private readonly tableName: string;
  private readonly appProfileId: string;

  constructor(
    private readonly context: BigtableRequestContext,
    tableId: string,
  ) {
    this.tableName = tablePath(context, tableId);
    this.appProfileId = context.bigtable.appProfileId ?? "";
  }

  /** 1 行を読む。行がない、または filter を通ったセルが 1 つもなければ undefined。 */
  async readRow(
    rowKey: Uint8Array,
    filter: BigtableRowFilter,
  ): Promise<BigtableRow | undefined> {
    // 1 行だけの読み取りは、その行が完成した後なら再開する行がない。再要求すると同じ行をまた完成させ続ける。
    const rows = await this.read(
      (resumeAfter) =>
        resumeAfter === undefined
          ? { rowKeys: [Buffer.from(rowKey)] }
          : undefined,
      filter,
    );
    return rows[0];
  }

  /** 範囲 [start, end) の行を、行キーの順に全て読む。途中で切れたら最後に完成した行の次から再開する。 */
  async readRange(
    start: Uint8Array,
    end: Uint8Array,
    filter: BigtableRowFilter,
  ): Promise<readonly BigtableRow[]> {
    return this.read(
      (resumeAfter) => ({
        rowRanges: [
          {
            ...(resumeAfter === undefined
              ? { startKeyClosed: Buffer.from(start) }
              : { startKeyOpen: Buffer.from(resumeAfter) }),
            endKeyOpen: Buffer.from(end),
          },
        ],
      }),
      filter,
    );
  }

  /** 条件付き更新（CheckAndMutateRow）を 1 回だけ送る。条件を満たしたかを返す。再送しない。 */
  async checkAndMutate(
    rowKey: Uint8Array,
    predicate: BigtableRowFilter,
    trueMutations: readonly BigtableMutation[],
    falseMutations: readonly BigtableMutation[],
  ): Promise<boolean> {
    const response = await sendUnary(
      this.context,
      "BigtableClient",
      "checkAndMutateRow",
      {
        tableName: this.tableName,
        appProfileId: this.appProfileId,
        rowKey: Buffer.from(rowKey),
        predicateFilter: predicate,
        trueMutations: [...trueMutations],
        falseMutations: [...falseMutations],
      },
    );
    return response.predicateMatched === true;
  }

  private read(
    rowSetOf: (
      resumeAfter: Uint8Array | undefined,
    ) => Record<string, unknown> | undefined,
    filter: BigtableRowFilter,
  ): Promise<readonly BigtableRow[]> {
    return readRows((resumeAfter) =>
      this.openStream(rowSetOf(resumeAfter), filter),
    );
  }

  private async *openStream(
    rows: Record<string, unknown> | undefined,
    filter: BigtableRowFilter,
  ): AsyncGenerator<BigtableReadRowsResponse> {
    // 読むべき行が残っていなければ、要求を送らずに流れを終える。
    if (rows === undefined) return;
    const gaxOpts = await prepare(this.context, "BigtableClient", "readRows");
    const stream = this.context.bigtable.request({
      client: "BigtableClient",
      method: "readRows",
      reqOpts: {
        tableName: this.tableName,
        appProfileId: this.appProfileId,
        rows,
        filter,
      },
      gaxOpts,
      // 再開は readRows が行う。SDK の自動再送は使わない。
      retryOpts: { retries: 0, noResponseRetries: 0 },
    });
    yield* stream as AsyncIterable<BigtableReadRowsResponse>;
  }
}

/** 管理 API の GetTable で列ファミリの定義を得る。テーブルがなければ undefined。 */
export async function getTableSchema(
  context: BigtableRequestContext,
  tableId: string,
): Promise<
  | Readonly<
      Record<string, Readonly<{ gcRule?: Record<string, unknown> | null }>>
    >
  | undefined
> {
  try {
    const table = await sendUnary(
      context,
      "BigtableTableAdminClient",
      "getTable",
      { name: tablePath(context, tableId), view: "SCHEMA_VIEW" },
    );
    return (table.columnFamilies ?? {}) as Record<
      string,
      { gcRule?: Record<string, unknown> | null }
    >;
  } catch (error) {
    // NOT_FOUND はテーブルがない。それ以外は保存先の失敗として伝える。
    const code = (error as { cause?: { code?: number } }).cause?.code;
    if (code === 5) return undefined;
    throw error;
  }
}
