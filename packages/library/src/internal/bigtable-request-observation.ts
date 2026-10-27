/** 要求を送る直前に観測できる内容。authorization は付けた場合だけある。 */
export type BigtableRequestObservation = Readonly<{
  client: "BigtableClient" | "BigtableTableAdminClient";
  method: string;
  authorization?: string;
}>;
