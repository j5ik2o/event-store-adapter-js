import type { Bigtable } from "@google-cloud/bigtable";
import type { BigtableEventStoreHooks } from "./bigtable-event-store-hooks";

/** 要求の境界が使う、クライアントと認証の差し込み。 */
export type BigtableRequestContext = Readonly<{
  bigtable: Bigtable;
  instanceId: string;
  accessToken?: () => string | Promise<string>;
  hooks?: BigtableEventStoreHooks;
}>;
