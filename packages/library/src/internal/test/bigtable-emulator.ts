import { Bigtable } from "@google-cloud/bigtable";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";

/** 生のセル。値・時刻（マイクロ秒）・版の並び（新しい順）を、デコードせずに返す。 */
export type RawCell = Readonly<{ value: Buffer; timestampMicros: number }>;
/** 列ファミリ → 列の修飾子 → セルの並び（新しい順）。 */
export type RawRow = Readonly<
  Record<string, Readonly<Record<string, readonly RawCell[]>>>
>;

export type BigtableStoreSetup = Readonly<{
  /** データの列ファミリの GC の最大版数。既定は 1（BT-2）。 */
  maxVersions?: number;
  /** 年齢による GC を付けるときの秒数。付けると列ファミリの照合が失敗する。 */
  maxAgeSeconds?: number;
  /** 作らない列ファミリ。"journal:event" のように、テーブルの種類と名前で指す。 */
  omitFamilies?: readonly string[];
}>;

export type BigtableTables = Readonly<{ journal: string; head: string }>;

const PROJECT = "test-project";
const INSTANCE = "test-instance";
const JOURNAL_FAMILIES = ["event", "history", "config"] as const;
const HEAD_FAMILIES = ["head", "snapshot", "config"] as const;

/** Bigtable エミュレーター。実サービスには接続せず、認証も付けない。 */
export class BigtableEmulator {
  // Rust 版と同じイメージ。固定したダイジェストで取得する。
  static readonly image =
    "gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:8d8573471c489a409f03891d2c24d177fa531276184f7002b9a2d853d1b3ed54";
  readonly instanceId = INSTANCE;
  readonly projectId = PROJECT;
  readonly endpoint: string;
  private tableCount = 0;

  private constructor(
    private readonly container: StartedTestContainer,
    readonly bigtable: Bigtable,
  ) {
    this.endpoint = `${container.getHost()}:${container.getMappedPort(8086)}`;
  }

  static async start(): Promise<BigtableEmulator> {
    const container = await BigtableEmulator.startContainer();
    const bigtable = new Bigtable({
      projectId: PROJECT,
      apiEndpoint: `${container.getHost()}:${container.getMappedPort(8086)}`,
      // 実サービスへ指標を送らない。
      metricsEnabled: false,
    });
    const emulator = new BigtableEmulator(container, bigtable);
    await emulator.waitUntilReady();
    return emulator;
  }

  private static async startContainer(): Promise<StartedTestContainer> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await new GenericContainer(BigtableEmulator.image)
          .withCommand([
            "gcloud",
            "beta",
            "emulators",
            "bigtable",
            "start",
            "--host-port=0.0.0.0:8086",
          ])
          .withExposedPorts(8086)
          .withWaitStrategy(
            Wait.forLogMessage(/Cloud Bigtable emulator running/),
          )
          .withStartupTimeout(180_000)
          .start();
      } catch (cause) {
        if (attempt >= 3) throw cause;
      }
    }
  }

  // 管理 API の ListTables が成功するまで待つ。
  private async waitUntilReady(): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.bigtable.instance(INSTANCE).getTables();
        return;
      } catch (cause) {
        if (attempt >= 60) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  /** この場面だけの journal・head の 2 テーブルを、列ファミリ付きで作る（設定行は書かない）。 */
  async createTables(setup: BigtableStoreSetup = {}): Promise<BigtableTables> {
    this.tableCount += 1;
    const tables = {
      journal: `journal-${this.tableCount}`,
      head: `head-${this.tableCount}`,
    };
    const omitted = new Set(setup.omitFamilies ?? []);
    const rule = {
      versions: setup.maxVersions ?? 1,
      ...(setup.maxAgeSeconds === undefined
        ? {}
        : { age: { seconds: setup.maxAgeSeconds } }),
    };
    const families = (kind: "journal" | "head", names: readonly string[]) =>
      names
        .filter((name) => !omitted.has(`${kind}:${name}`))
        .map((name) => ({
          name,
          // 設定の列ファミリの GC は照合の対象外。データの列ファミリだけに規則を付ける。
          ...(name === "config" ? {} : { rule }),
        }));
    const instance = this.bigtable.instance(INSTANCE);
    await instance.createTable(tables.journal, {
      families: families("journal", JOURNAL_FAMILIES),
    });
    await instance.createTable(tables.head, {
      families: families("head", HEAD_FAMILIES),
    });
    return tables;
  }

  /** 生の行を、全版のセルのまま読む。行がなければ undefined。 */
  async readRow(
    table: string,
    rowKey: Uint8Array,
  ): Promise<RawRow | undefined> {
    const [rows] = await this.bigtable
      .instance(INSTANCE)
      .table(table)
      .getRows({
        ranges: [
          {
            start: { value: Buffer.from(rowKey), inclusive: true },
            end: { value: Buffer.from(rowKey), inclusive: true },
          },
        ],
        decode: false,
      });
    const row = rows[0];
    if (row === undefined) return undefined;
    const data = row.data as Record<
      string,
      Record<string, { value: Buffer; timestamp: string | number }[]>
    >;
    return Object.fromEntries(
      Object.entries(data).map(([family, columns]) => [
        family,
        Object.fromEntries(
          Object.entries(columns).map(([qualifier, cells]) => [
            qualifier,
            cells.map((cell) => ({
              value: Buffer.from(cell.value),
              timestampMicros: Number(cell.timestamp),
            })),
          ]),
        ),
      ]),
    );
  }

  /** 生のセルを書く。時刻（マイクロ秒）を指定でき、省略すると 0。 */
  async writeCell(
    table: string,
    rowKey: Uint8Array,
    family: string,
    qualifier: string,
    value: Uint8Array,
    timestampMicros = 0,
  ): Promise<void> {
    await this.bigtable
      .instance(INSTANCE)
      .table(table)
      .mutate([
        {
          key: Buffer.from(rowKey),
          method: "insert",
          data: {
            [family]: {
              [qualifier]: {
                value: Buffer.from(value),
                timestamp: new Date(timestampMicros / 1000),
              },
            },
          },
        },
      ]);
  }

  /** 行の全体を削除する（保持の後の履歴の消失を作るために使う）。 */
  async deleteRow(table: string, rowKey: Uint8Array): Promise<void> {
    await this.bigtable
      .instance(INSTANCE)
      .table(table)
      .mutate([{ key: Buffer.from(rowKey), method: "delete" }]);
  }

  async stop(): Promise<void> {
    this.bigtable.close();
    await this.container.stop();
  }
}
