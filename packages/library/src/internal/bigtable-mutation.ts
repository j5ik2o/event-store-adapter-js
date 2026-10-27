/** v2 の Mutation を表す JSON。`Bigtable#request` の reqOpts にそのまま渡す。 */
export type BigtableMutation = Readonly<Record<string, unknown>>;
