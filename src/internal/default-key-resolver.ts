import { AggregateId, KeyResolver } from "../types";

class DefaultKeyResolver<AID extends AggregateId> implements KeyResolver<AID> {
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash >>> 0; // Convert to unsigned 32bit integer
  }

  resolvePartitionKey(aggregateId: AID, shardCount: number): string {
    const hash = this.hashString(aggregateId.asString());
    const remainder = hash % shardCount;
    return `${aggregateId.typeName()}-${remainder}`;
  }

  resolveSortKey(aggregateId: AID, sequenceNumber: number): string {
    return `${aggregateId.typeName()}-${aggregateId.value()}-${sequenceNumber}`;
  }
}

export { DefaultKeyResolver };
