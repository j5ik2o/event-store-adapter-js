import { renderConfigurationJson } from "../../bigtable-configuration-json";
import { recordOf, textOf } from "./conformance-json-access";
import type { ConformanceJsonValue } from "./conformance-json-value";

/** 適合データの `seed.configuration` の 1 テーブル分を、設定行の JSON にする。 */
export function configurationJsonOf(record: ConformanceJsonValue): Uint8Array {
  const fields = recordOf(record);
  const keep = fields.keep_snapshot_count;
  return renderConfigurationJson({
    storeId: textOf(fields.store_id),
    layoutVersion: Number(fields.layout_version),
    keepSnapshotCount:
      keep === null || keep === undefined ? null : Number(keep),
    retentionMode: textOf(fields.retention_mode),
    envelopeLimitBytes: Number(fields.envelope_limit_bytes),
  });
}
