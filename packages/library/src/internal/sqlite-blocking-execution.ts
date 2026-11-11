import { Worker } from "node:worker_threads";
import { EventStoreError } from "../event-store-error";
import { Result } from "../result";
import type { SqliteBlockingExecution } from "../sqlite-blocking-execution";
import {
  SQLITE_WORKER_SHUTDOWN,
  type SqliteWorkerRequest,
  type SqliteWorkerResponse,
} from "./sqlite-worker-requests";

/** ストアが要求をワーカーへ送る口。利用者には見せない。 */
export type SqliteWorkerLane = Readonly<{
  /**
   * 要求を待ち行列に入れ、ワーカーの答えを返す。満杯か閉じているときは、送らずに保存先エラーを返す。
   * `bounded` が false の要求（接続を閉じる要求）は、満杯でも受け付ける。
   */
  submit<K extends SqliteWorkerRequest["kind"]>(
    request: Extract<SqliteWorkerRequest, { kind: K }>,
    bounded?: boolean,
  ): Promise<Result<SqliteWorkerResponse<K>, EventStoreError>>;
}>;

const lanes = new WeakMap<SqliteBlockingExecution, SqliteWorkerLane>();

export function sqliteWorkerLaneOf(
  execution: SqliteBlockingExecution,
): Result<SqliteWorkerLane, EventStoreError> {
  const lane = lanes.get(execution);
  return lane === undefined
    ? Result.err(
        EventStoreError.configuration(
          "execution",
          "execution must be created by SqliteBlockingExecution.singleWorker",
        ),
      )
    : Result.ok(lane);
}

type Lifecycle = "open" | "closing" | "exited";

type Waiting = Readonly<{
  answer: (answer: Result<unknown, EventStoreError>) => void;
  bounded: boolean;
}>;

/**
 * ワーカー 1 つと、実行中の 1 件のほかに queueCapacity 件を待たせる待ち行列を持つ実行資源を作る。
 * 接続を閉じる要求は上限に数えない。
 */
export function createSqliteBlockingExecution(
  queueCapacity: number,
  startWorker: () => Worker,
): Result<SqliteBlockingExecution, EventStoreError> {
  if (!Number.isSafeInteger(queueCapacity) || queueCapacity < 1)
    return Result.err(
      EventStoreError.configuration(
        "queueCapacity",
        "queueCapacity must be a positive safe integer",
      ),
    );
  let worker: Worker;
  try {
    worker = startWorker();
  } catch (cause) {
    // 権限モデルで worker_threads が許されていないときや、要求の処理のファイルが見つからないとき。
    return Result.err(
      EventStoreError.storage("SQLite worker could not be started", cause),
    );
  }
  // 受け付けた操作があるあいだだけ、ワーカーがプロセスを生かす。
  worker.unref();
  let lifecycle: Lifecycle = "open";
  // 答えを待つ要求を、送った順の番号で持つ。ワーカーは届いた順に答えるので、次に答えが届くのは answered 番。
  // NOTE: 待ち行列はこの実行資源の状態そのものなので、ここで可変にする。
  const waiting = new Map<number, Waiting>();
  let submitted = 0;
  let answered = 0;
  // 上限に数える要求（接続を閉じる要求を除く）のうち、答えを待っている件数。
  let boundedWaiting = 0;
  let failure: unknown;
  const termination = Promise.withResolvers<void>();

  const take = (id: number): Waiting["answer"] => {
    const entry = waiting.get(id) as Waiting;
    waiting.delete(id);
    if (entry.bounded) boundedWaiting -= 1;
    return entry.answer;
  };
  worker.on("message", (response: unknown) => {
    const answer = take(answered);
    answered += 1;
    if (waiting.size === 0 && lifecycle === "open") worker.unref();
    answer(Result.ok(response));
  });
  worker.on("error", (cause) => {
    failure = cause;
  });
  worker.on("exit", () => {
    lifecycle = "exited";
    // 実行中だった 1 件は、確定したかどうか分からない。
    for (const id of [...waiting.keys()])
      take(id)(
        Result.err(
          EventStoreError.storage(
            "SQLite worker stopped before answering",
            failure,
          ),
        ),
      );
    termination.resolve();
  });

  const lane: SqliteWorkerLane = {
    submit<K extends SqliteWorkerRequest["kind"]>(
      request: Extract<SqliteWorkerRequest, { kind: K }>,
      bounded = true,
    ): Promise<Result<SqliteWorkerResponse<K>, EventStoreError>> {
      if (lifecycle !== "open")
        return Promise.resolve(
          Result.err(
            EventStoreError.storage("SQLite blocking execution is closed"),
          ),
        );
      if (bounded && boundedWaiting > queueCapacity)
        return Promise.resolve(
          Result.err(
            EventStoreError.storage("SQLite blocking execution is full"),
          ),
        );
      return new Promise((resolve) => {
        // 送れたものだけを待つ。送れずに投げたときは、この Promise が拒否される。
        worker.postMessage(request);
        if (waiting.size === 0) worker.ref();
        waiting.set(submitted, {
          answer: resolve as Waiting["answer"],
          bounded,
        });
        submitted += 1;
        if (bounded) boundedWaiting += 1;
      });
    },
  };
  const execution: SqliteBlockingExecution = Object.freeze({
    close(): void {
      if (lifecycle !== "open") return;
      lifecycle = "closing";
      // 受け付け済みの操作を終えてワーカーが終わるまで、プロセスを生かす。
      worker.ref();
      worker.postMessage(SQLITE_WORKER_SHUTDOWN);
    },
    drained: () => termination.promise,
  });
  lanes.set(execution, lane);
  return Result.ok(execution);
}

/**
 * ワーカーは、このファイルの隣の要求の処理を読み込む。
 * ソースの .ts から読み込まれたとき（このライブラリの試験）は、ワーカーにも TypeScript を読ませる。
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
if (workerData.endsWith(".ts"))
  require(require.resolve("ts-node/register/transpile-only", { paths: [workerData] }));
require(workerData).serveSqliteWorkerRequests(parentPort);
`;

export function startSqliteWorker(): Worker {
  return new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: require.resolve("./sqlite-worker-requests"),
  });
}
