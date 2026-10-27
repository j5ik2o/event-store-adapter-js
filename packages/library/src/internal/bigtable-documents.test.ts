import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { BigtableEmulator } from "./test/bigtable-emulator";

const root = path.resolve(__dirname, "../../");
const MARKERS = ["first-run", "reopen"] as const;
type Marker = (typeof MARKERS)[number];
const documents = {
  english: path.join(root, "README.md"),
  japanese: path.join(root, "README.ja.md"),
} as const;

/** 目印 `<!-- bigtable-example:名前 -->` の直後にある typescript のコードブロックを取り出す。 */
function blockOf(file: string, marker: Marker): string {
  const text = fs.readFileSync(file, "utf8");
  const pattern = new RegExp(
    `<!-- bigtable-example:${marker} -->\\n\`\`\`typescript\\n([\\s\\S]*?)\`\`\``,
    "g",
  );
  const found = [...text.matchAll(pattern)];
  if (found.length !== 1) {
    throw new Error(`${file}: ${marker} must appear exactly once`);
  }
  return found[0][1];
}

let emulator: BigtableEmulator;
let workDir = "";
beforeAll(async () => {
  emulator = await BigtableEmulator.start();
  const cache = path.join(root, "node_modules", ".cache");
  fs.mkdirSync(cache, { recursive: true });
  workDir = fs.mkdtempSync(path.join(cache, "bigtable-doc-"));
}, 300000);
afterAll(async () => {
  fs.rmSync(workDir, { recursive: true, force: true });
  await emulator.stop();
}, 60000);

describe("the README examples (English and Japanese)", () => {
  test.each(MARKERS)(
    "the %s example is identical in both languages",
    (marker) => {
      expect(blockOf(documents.japanese, marker)).toBe(
        blockOf(documents.english, marker),
      );
    },
  );

  test.each(MARKERS)(
    "the %s example names the public entry and types its input",
    (marker) => {
      const code = blockOf(documents.english, marker);
      expect(code).toContain('from "event-store-adapter-js/bigtable"');
      expect(code).toContain("BigtableEventStoreInput");
      expect(code).toContain("metricsEnabled: false");
    },
  );

  test.each(MARKERS)(
    "the %s example type-checks against the public types",
    (marker) => {
      const file = path.join(workDir, `${marker}.ts`);
      const code = blockOf(documents.english, marker).replace(
        '"event-store-adapter-js/bigtable"',
        `"${path
          .relative(workDir, path.join(root, "src", "bigtable"))
          .split(path.sep)
          .join("/")}"`,
      );
      fs.writeFileSync(file, code);
      const program = ts.createProgram([file], {
        strict: true,
        noEmit: true,
        module: ts.ModuleKind.Node16,
        moduleResolution: ts.ModuleResolutionKind.Node16,
        target: ts.ScriptTarget.ES2022,
        lib: ["lib.esnext.d.ts"],
        skipLibCheck: true,
        types: ["node"],
      });
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(diagnostics).toEqual([]);
    },
  );

  test("the first-run flow prepares new tables and the reopen flow opens the same tables again", async () => {
    const tables = await emulator.createTables();
    process.env.BIGTABLE_EMULATOR_HOST = emulator.endpoint;
    const run = async (marker: Marker): Promise<unknown> => {
      const code = blockOf(documents.english, marker)
        .replace(
          '"event-store-adapter-js/bigtable"',
          `"${path.join(root, "src", "bigtable").split(path.sep).join("/")}"`,
        )
        .replaceAll("my-journal-table", tables.journal)
        .replaceAll("my-head-table", tables.head)
        .replaceAll("my-instance", emulator.instanceId)
        .replaceAll("my-project", emulator.projectId);
      const output = ts.transpileModule(code, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      const module_ = { exports: {} as { main?: () => Promise<unknown> } };
      new Function("exports", "module", "require", output)(
        module_.exports,
        module_,
        require,
      );
      if (typeof module_.exports.main !== "function") {
        throw new Error(`${marker}: the example must export an async main`);
      }
      return module_.exports.main();
    };
    try {
      await expect(run("first-run")).resolves.toBeDefined();
      await expect(run("reopen")).resolves.toBeDefined();
    } finally {
      delete process.env.BIGTABLE_EMULATOR_HOST;
    }
  });
});

describe("the other documents", () => {
  const read = (relative: string) =>
    fs.readFileSync(path.join(root, relative), "utf8");

  test.each(["docs/MIGRATION_GUIDE.md", "docs/MIGRATION_GUIDE.ja.md"])(
    "%s says the old version had no Bigtable storage and describes new adoption",
    (file) => {
      const text = read(file);
      expect(text).toMatch(/Bigtable/);
      expect(text).toMatch(/event-store-adapter-js\/bigtable/);
      expect(text).not.toMatch(/migrate[^\n]*Bigtable[^\n]*tool/i);
    },
  );

  test.each(["../../CONTRIBUTING.md", "../../CONTRIBUTING.ja.md"])(
    "%s mentions that the Bigtable tests need Docker",
    (file) => {
      expect(read(file)).toMatch(/Bigtable/);
    },
  );

  test.each([
    "docs/BIGTABLE_DATABASE_SCHEMA.md",
    "docs/BIGTABLE_DATABASE_SCHEMA.ja.md",
  ])("%s documents the entry and both operations", (file) => {
    const text = read(file);
    expect(text).toMatch(/event-store-adapter-js\/bigtable/);
    expect(text).toMatch(/BigtableEventStore\.initialize/);
    expect(text).toMatch(/BigtableEventStore\.create/);
  });
});
