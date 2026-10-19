import * as fs from "node:fs";
import * as path from "node:path";
import { SpannerEventStore } from "../spanner";
import { SpannerEmulator } from "./test/spanner-emulator";

const MARKERS = [
  "tables",
  "snapshot-history-delete",
  "snapshot-history-ttl",
  "config-delete",
  "config-ttl",
] as const;
type Marker = (typeof MARKERS)[number];

const documentPaths = [
  path.resolve(__dirname, "../../docs/SPANNER_DATABASE_SCHEMA.md"),
  path.resolve(__dirname, "../../docs/SPANNER_DATABASE_SCHEMA.ja.md"),
];

/** 目印 `<!-- spanner-schema:名前 -->` の直後にある sql のコードブロックを取り出す。 */
function blocksOf(file: string): Record<Marker, string> {
  const text = fs.readFileSync(file, "utf8");
  const entries = MARKERS.map((marker) => {
    const pattern = new RegExp(
      `<!-- spanner-schema:${marker} -->\\n\`\`\`sql\\n([\\s\\S]*?)\`\`\``,
      "g",
    );
    const found = [...text.matchAll(pattern)];
    if (found.length !== 1)
      throw new Error(`${file}: ${marker} must appear exactly once`);
    return [marker, found[0][1]] as const;
  });
  return Object.fromEntries(entries) as Record<Marker, string>;
}

const withPrefix = (sql: string, prefix: string) =>
  sql.replace(/\besa_/g, `${prefix}_`);
const statementsOf = (sql: string) =>
  sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

// 試験ごとに別の接頭辞を使うための連番。
let prefixes = 0;
const nextPrefix = () => {
  prefixes += 1;
  return `doc${prefixes}`;
};

let emulator: SpannerEmulator;
beforeAll(async () => {
  emulator = await SpannerEmulator.start();
}, 240000);
afterAll(async () => {
  await emulator.stop();
}, 60000);

describe("schema documents", () => {
  const [english, japanese] = documentPaths.map(blocksOf);

  it.each(MARKERS)("uses the same %s block in both languages", (marker) => {
    expect(japanese[marker]).toBe(english[marker]);
  });

  it.each([
    {
      mode: "delete",
      history: "snapshot-history-delete",
      configuration: "config-delete",
      retention: { count: 3 },
    },
    {
      mode: "ttl",
      history: "snapshot-history-ttl",
      configuration: "config-ttl",
      retention: { count: 3, mode: { type: "ttl", graceDays: 7 } },
    },
  ] as const)(
    "lets create succeed on the $mode tables built from the document",
    async ({ history, configuration, retention }) => {
      for (const blocks of [english, japanese]) {
        const prefix = nextPrefix();
        const [operation] = await emulator.database.updateSchema(
          statementsOf(
            withPrefix(`${blocks.tables}\n${blocks[history]}`, prefix),
          ),
        );
        await operation.promise();
        await emulator.database.runTransactionAsync(async (transaction) => {
          for (const statement of statementsOf(
            withPrefix(blocks[configuration], prefix),
          ))
            await transaction.runUpdate(statement);
          await transaction.commit();
        });
        const created = await SpannerEventStore.create({
          database: emulator.database,
          tablePrefix: prefix,
          retention,
        });
        expect(created.type).toBe("ok");
      }
    },
    120000,
  );
});
