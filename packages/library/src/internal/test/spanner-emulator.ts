import { type Database, Spanner } from "@google-cloud/spanner";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";

export type SpannerSeedConfiguration = Readonly<{
  store_id: string;
  layout_version: number;
  keep_snapshot_count: number | null;
  retention_mode: string;
  ttl_grace_days: number | null;
  change_feed_enabled: boolean;
}>;

export type SpannerStoreSetup = Readonly<{
  /** snapshot_history の行削除ポリシーの日数。null なら設定しない。 */
  rowDeletionPolicyDays?: number | null;
  /** config に書く 1 行。null なら config を空のままにする。 */
  configuration?: SpannerSeedConfiguration | null;
}>;

const PROJECT = "test-project";
const INSTANCE = "test-instance";
const DATABASE = "test-database";

/** Spanner エミュレーター。初期化の手順（5 テーブルと config の 1 行）は生成とは別に、ここで行う。 */
export class SpannerEmulator {
  // 2026-09-15 公開の 1.5.58。固定したダイジェストで取得する。
  static readonly image =
    "gcr.io/cloud-spanner-emulator/emulator:1.5.58@sha256:c6f3402f2599684f295a0fdefb6fbbbfb18a0e43e309ff5456ccb452a4570a79";
  private prefixes = 0;

  private constructor(
    private readonly container: StartedTestContainer,
    private readonly spanner: Spanner,
    readonly database: Database,
  ) {}

  static async start(): Promise<SpannerEmulator> {
    const container = await SpannerEmulator.startContainer();
    // SDK はエミュレーターの接続先を環境変数から読む。実サービスには接続しない。
    process.env.SPANNER_EMULATOR_HOST = `${container.getHost()}:${container.getMappedPort(9010)}`;
    const spanner = new Spanner({ projectId: PROJECT });
    const [instance, instanceOperation] = await spanner.createInstance(
      INSTANCE,
      { config: "emulator-config", nodes: 1, displayName: INSTANCE },
    );
    await instanceOperation.promise();
    const [database, databaseOperation] = await instance.createDatabase(
      DATABASE,
      { schema: [] },
    );
    await databaseOperation.promise();
    return new SpannerEmulator(container, spanner, database);
  }

  // Docker がコンテナーのポートの割り当てを返さずに起動が 30 秒で失敗することが、手元の Docker で
  // 10 回に 1 回ほどあった。エミュレーターを使う前の失敗なので、起動だけを最大 3 回まで試す。
  private static async startContainer(): Promise<StartedTestContainer> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await new GenericContainer(SpannerEmulator.image)
          .withExposedPorts(9010, 9020)
          .withWaitStrategy(Wait.forLogMessage(/gRPC server listening/))
          .withStartupTimeout(120_000)
          .start();
      } catch (cause) {
        if (attempt >= 3) throw cause;
      }
    }
  }

  /** 同じデータベースに、この場面だけの接頭辞でテーブルを作る。 */
  async createStore(setup: SpannerStoreSetup = {}): Promise<string> {
    this.prefixes += 1;
    const prefix = `esa${this.prefixes}`;
    const policy =
      setup.rowDeletionPolicyDays == null
        ? ""
        : `, ROW DELETION POLICY (OLDER_THAN(expired_at, INTERVAL ${setup.rowDeletionPolicyDays} DAY))`;
    const key = "hash_prefix BYTES(8) NOT NULL, aid STRING(1024) NOT NULL";
    const [operation] = await this.database.updateSchema([
      `CREATE TABLE ${prefix}_journal (${key}, seq_nr INT64 NOT NULL, occurred_at_ns INT64 NOT NULL, manifest STRING(MAX) NOT NULL, payload BYTES(MAX) NOT NULL) PRIMARY KEY (hash_prefix, aid, seq_nr)`,
      `CREATE TABLE ${prefix}_head (${key}, type_name STRING(1024) NOT NULL, seq_nr INT64 NOT NULL, event_occurred_at_ns INT64 NOT NULL, event_manifest STRING(MAX) NOT NULL, event_payload BYTES(MAX) NOT NULL) PRIMARY KEY (hash_prefix, aid)`,
      `CREATE TABLE ${prefix}_snapshot_current (${key}, seq_nr INT64 NOT NULL, manifest STRING(MAX) NOT NULL, payload BYTES(MAX) NOT NULL) PRIMARY KEY (hash_prefix, aid)`,
      `CREATE TABLE ${prefix}_snapshot_history (${key}, seq_nr INT64 NOT NULL, manifest STRING(MAX) NOT NULL, payload BYTES(MAX) NOT NULL, expired_at TIMESTAMP) PRIMARY KEY (hash_prefix, aid, seq_nr)${policy}`,
      `CREATE TABLE ${prefix}_config (singleton INT64 NOT NULL, store_id STRING(36) NOT NULL, layout_version INT64 NOT NULL, keep_snapshot_count INT64, retention_mode STRING(8) NOT NULL, ttl_grace_days INT64, change_feed_enabled BOOL NOT NULL) PRIMARY KEY (singleton)`,
    ]);
    await operation.promise();
    const configuration = setup.configuration;
    if (configuration !== null && configuration !== undefined) {
      await this.database.runTransactionAsync(async (transaction) => {
        await transaction.runUpdate({
          sql: `INSERT INTO ${prefix}_config (singleton, store_id, layout_version, keep_snapshot_count, retention_mode, ttl_grace_days, change_feed_enabled) VALUES (1, @store_id, @layout_version, @keep_snapshot_count, @retention_mode, @ttl_grace_days, @change_feed_enabled)`,
          params: {
            store_id: configuration.store_id,
            layout_version: configuration.layout_version.toString(),
            keep_snapshot_count: nullableInt(configuration.keep_snapshot_count),
            retention_mode: configuration.retention_mode,
            ttl_grace_days: nullableInt(configuration.ttl_grace_days),
            change_feed_enabled: configuration.change_feed_enabled,
          },
          types: {
            store_id: "string",
            layout_version: "int64",
            keep_snapshot_count: "int64",
            retention_mode: "string",
            ttl_grace_days: "int64",
            change_feed_enabled: "bool",
          },
        });
        await transaction.commit();
      });
    }
    return prefix;
  }

  async stop(): Promise<void> {
    await this.database.close();
    this.spanner.close();
    await this.container.stop();
  }
}

const nullableInt = (value: number | null): string | null =>
  value === null ? null : value.toString();
