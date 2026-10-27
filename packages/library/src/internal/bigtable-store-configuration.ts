import { randomUUID } from "node:crypto";
import { EventStoreError } from "../event-store-error";
import {
  parseConfigurationJson,
  renderConfigurationJson,
} from "./bigtable-configuration-json";
import type { BigtableRecordedConfiguration } from "./bigtable-recorded-configuration";
import type { BigtableRequestContext } from "./bigtable-request-context";
import {
  CONFIG_METADATA,
  FAMILY_CONFIG,
  FAMILY_EVENT,
  FAMILY_HEAD,
  FAMILY_HISTORY,
  FAMILY_SNAPSHOT,
  latestCellExists,
  setCell,
} from "./bigtable-request-parts";
import { BigtableTableRequests, getTableSchema } from "./bigtable-requests";
import { cellValue } from "./bigtable-row";
import { CONFIG_ROW_KEY } from "./bigtable-row-keys";

const JOURNAL_FAMILIES = [FAMILY_EVENT, FAMILY_HISTORY, FAMILY_CONFIG];
const HEAD_FAMILIES = [FAMILY_HEAD, FAMILY_SNAPSHOT, FAMILY_CONFIG];
const LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 検証済みの設定のうち、照合と初期化が使う部分。 */
export type BigtableStoreSettings = Readonly<{
  tables: Readonly<{ journal: string; head: string }>;
  retentionCount: number | undefined;
  envelopeLimitBytes: number;
}>;

const mismatch = (message: string) =>
  EventStoreError.configuration(
    "configuration",
    `the Bigtable store does not match its recorded configuration: ${message}`,
  );

/**
 * 列ファミリが全て揃い、データの列ファミリの GC が「最大 1 版」だけであることを確かめる（BT-2）。
 * 設定の列ファミリは存在だけを見る。年齢による GC は許さない。
 */
async function verifyColumnFamilies(
  context: BigtableRequestContext,
  tableId: string,
  families: readonly string[],
): Promise<void> {
  const schema = await getTableSchema(context, tableId);
  if (schema === undefined) throw mismatch(`table ${tableId} does not exist`);
  for (const family of families) {
    const definition = schema[family];
    if (definition === undefined)
      throw mismatch(`column family ${family} is missing`);
    if (family === FAMILY_CONFIG) continue;
    const rule = definition.gcRule;
    if (rule?.rule !== "maxNumVersions" || Number(rule.maxNumVersions) !== 1)
      throw mismatch(`column family ${family} must keep exactly one version`);
  }
}

async function readConfiguration(
  table: BigtableTableRequests,
): Promise<Uint8Array | undefined> {
  const row = await table.readRow(
    CONFIG_ROW_KEY,
    latestCellExists(FAMILY_CONFIG, CONFIG_METADATA),
  );
  return row === undefined
    ? undefined
    : cellValue(row, FAMILY_CONFIG, CONFIG_METADATA);
}

function verifyRecorded(
  journal: BigtableRecordedConfiguration,
  head: BigtableRecordedConfiguration,
  settings: BigtableStoreSettings,
): void {
  if (JSON.stringify(journal) !== JSON.stringify(head))
    throw mismatch("the two tables record different configurations");
  if (journal.layoutVersion !== 1 || journal.retentionMode !== "delete")
    throw mismatch("unsupported layout version or retention mode");
  if (!LOWERCASE_UUID.test(journal.storeId))
    throw mismatch("store_id is not a lowercase UUID");
  if (journal.keepSnapshotCount !== (settings.retentionCount ?? null))
    throw mismatch("keep_snapshot_count differs");
  if (journal.envelopeLimitBytes !== settings.envelopeLimitBytes)
    throw mismatch("envelope_limit_bytes differs");
}

/** テーブルと設定行を照合する。何も作らず、欠けた側も補わない（BT-D1）。 */
export async function verifyBigtableStore(
  context: BigtableRequestContext,
  settings: BigtableStoreSettings,
): Promise<void> {
  await verifyColumnFamilies(
    context,
    settings.tables.journal,
    JOURNAL_FAMILIES,
  );
  await verifyColumnFamilies(context, settings.tables.head, HEAD_FAMILIES);
  const journal = await readConfiguration(
    new BigtableTableRequests(context, settings.tables.journal),
  );
  const head = await readConfiguration(
    new BigtableTableRequests(context, settings.tables.head),
  );
  if (journal === undefined || head === undefined)
    throw mismatch(
      "the configuration row is missing; initialize the store first",
    );
  verifyRecorded(
    parseConfigurationJson(journal),
    parseConfigurationJson(head),
    settings,
  );
}

async function createConfigurationRow(
  table: BigtableTableRequests,
  json: Uint8Array,
): Promise<void> {
  const alreadyExists = await table.checkAndMutate(
    CONFIG_ROW_KEY,
    latestCellExists(FAMILY_CONFIG, CONFIG_METADATA),
    [],
    [setCell(FAMILY_CONFIG, CONFIG_METADATA, json)],
  );
  if (alreadyExists)
    throw EventStoreError.configuration(
      "tables",
      "the tables are already initialized",
    );
}

/**
 * 用意済みの 2 つのテーブルに、同じ store_id の設定行を作る（BT-D1）。
 * テーブルと列ファミリは作らない。どちらかに設定行が既にあれば、何も書かず設定エラーにする。
 */
export async function initializeBigtableStoreRows(
  context: BigtableRequestContext,
  settings: BigtableStoreSettings,
): Promise<void> {
  await verifyColumnFamilies(
    context,
    settings.tables.journal,
    JOURNAL_FAMILIES,
  );
  await verifyColumnFamilies(context, settings.tables.head, HEAD_FAMILIES);
  const journal = new BigtableTableRequests(context, settings.tables.journal);
  const head = new BigtableTableRequests(context, settings.tables.head);
  for (const table of [journal, head]) {
    if ((await readConfiguration(table)) !== undefined)
      throw EventStoreError.configuration(
        "tables",
        "the tables are already initialized",
      );
  }
  const json = renderConfigurationJson({
    storeId: randomUUID().toLowerCase(),
    layoutVersion: 1,
    keepSnapshotCount: settings.retentionCount ?? null,
    retentionMode: "delete",
    envelopeLimitBytes: settings.envelopeLimitBytes,
  });
  await createConfigurationRow(journal, json);
  await createConfigurationRow(head, json);
}
