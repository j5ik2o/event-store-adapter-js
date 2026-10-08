declare const memoryStorageBrand: unique symbol;

/** 保存先の実体と生成はメモリ実装の工程で追加する。 */
export type MemoryStorage = Readonly<{ [memoryStorageBrand]: true }>;
