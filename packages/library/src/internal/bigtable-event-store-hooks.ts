import type { BigtableRequestObservation } from "./bigtable-request-observation";

type Hook<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

/** 内部試験用。同期・非同期のどちらでもよく、投げると、その段階の失敗として扱われる。 */
export type BigtableEventStoreHooks = Readonly<{
  /** head の直前のイベントを journal へ書き出す直前に呼ぶ。投げると head を進めずに保存先エラーになる。 */
  journalWritePrevious?: Hook<[aid: string, seqNr: number]>;
  /** head の条件付き更新（CheckAndMutateRow）を送る直前に呼ぶ。 */
  beforeCommit?: Hook<[aid: string, seqNr: number]>;
  /** 条件付き更新の応答を受け取った直後に呼ぶ。投げると、応答を失った場合と同じ保存先エラーになる。 */
  afterCommit?: Hook<[aid: string, seqNr: number]>;
  /** 確定後に、新しい末尾を journal へ書き出す直前に呼ぶ。投げると通知の経路で知らされ、追記は成功のまま。 */
  journalWriteTail?: Hook<[aid: string, seqNr: number]>;
  /** 読み取りで head を読んだ直後に呼ぶ。 */
  afterReadHead?: Hook<[read: "events" | "snapshot"]>;
  /** 保持で、読み取った active な履歴の一覧を受け取り、整理の候補にする一覧を返す。 */
  listHistory?: (
    aid: string,
    seqNrs: readonly number[],
  ) => readonly number[] | Promise<readonly number[]>;
  /** 保持で、履歴を retired にする直前に呼ぶ。投げると保持の失敗として通知される。 */
  beforeRetentionDelete?: Hook<[aid: string, seqNrs: readonly number[]]>;
  /** aid のハッシュを差し替える。ハッシュの衝突を作るために使う。 */
  aggregateHash?: (aid: string) => bigint;
  /** 要求を送る直前に呼ぶ。 */
  beforeRequest?: Hook<[request: BigtableRequestObservation]>;
}>;
