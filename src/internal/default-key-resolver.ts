import { AggregateId, KeyResolver } from "../types";
import { LoggerFactory } from "./logger-factory";

class DefaultKeyResolver<AID extends AggregateId> implements KeyResolver<AID> {
  private logger = LoggerFactory.createLogger();
  private hashString(str: string): number {
    // this.logger.debug("hashString = ", str);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash >>> 0; // Convert to unsigned 32bit integer
  }

  resolvePartitionKey(aggregateId: AID, shardCount: number): string {
    // this.logger.debug("resolvePartitionKey = ", aggregateId.asString, shardCount);
    const hash = this.hashString(aggregateId.asString);
    const remainder = hash % shardCount;
    return `${aggregateId.typeName}-${remainder}`;
  }

  resolveSortKey(aggregateId: AID, sequenceNumber: number): string {
    return `${aggregateId.typeName}-${aggregateId.value}-${sequenceNumber}`;
  }
}

export { DefaultKeyResolver };
