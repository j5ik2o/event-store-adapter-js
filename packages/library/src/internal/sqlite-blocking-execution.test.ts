import { Worker } from "node:worker_threads";
import {
  createSqliteBlockingExecution,
  sqliteWorkerLaneOf,
} from "./sqlite-blocking-execution";

// 要求を受けると投げて終わるワーカー。実ワーカーが予期せず終わったときの扱いを確かめる。
const crashingWorker = () =>
  new Worker(
    `require("node:worker_threads").parentPort.on("message", () => { throw new Error("worker crashed"); });`,
    { eval: true },
  );

test("when the worker stops unexpectedly, the accepted operation fails as a storage error, later ones are rejected, and drained settles", async () => {
  const execution = createSqliteBlockingExecution(1, crashingWorker);
  if (execution.type === "err") throw new Error(execution.error.message);
  const lane = sqliteWorkerLaneOf(execution.value);
  if (lane.type === "err") throw new Error(lane.error.message);
  const request = {
    kind: "open",
    path: "unused",
    lockWaitMilliseconds: 0,
    retentionCount: undefined,
  } as const;
  expect(await lane.value.submit(request)).toMatchObject({
    type: "err",
    error: {
      type: "storage-error",
      message: "SQLite worker stopped before answering",
      cause: { message: "worker crashed" },
    },
  });
  expect(await lane.value.submit(request)).toEqual({
    type: "err",
    error: {
      type: "storage-error",
      message: "SQLite blocking execution is closed",
    },
  });
  await execution.value.drained();
  execution.value.close();
});

test("a worker that cannot be started is a storage error, not an exception", () => {
  const denied = new Error("worker_threads is not allowed");
  expect(
    createSqliteBlockingExecution(1, () => {
      throw denied;
    }),
  ).toEqual({
    type: "err",
    error: {
      type: "storage-error",
      message: "SQLite worker could not be started",
      cause: denied,
    },
  });
});
