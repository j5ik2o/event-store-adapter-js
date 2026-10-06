import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verifyConformanceManifest } from "./conformance-manifest";

const root = path.resolve(__dirname, "../../../../../../../conformance");

describe("verifyConformanceManifest", () => {
  let copy: string | undefined;

  const makeCopy = (): string => {
    copy = fs.mkdtempSync(path.join(os.tmpdir(), "conformance-"));
    fs.cpSync(root, copy, { recursive: true });
    return copy;
  };

  afterEach(() => {
    if (copy !== undefined) {
      fs.rmSync(copy, { recursive: true, force: true });
      copy = undefined;
    }
  });

  test("accepts the real conformance data", () => {
    const result = verifyConformanceManifest(root);
    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(22);
    expect(result.mismatches).toEqual([]);
  });

  test("reports a changed file", () => {
    const dir = makeCopy();
    fs.appendFileSync(path.join(dir, "values", "aid.json"), " ");
    const result = verifyConformanceManifest(dir);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toContain("values/aid.json");
  });

  test("reports a deleted file", () => {
    const dir = makeCopy();
    fs.rmSync(path.join(dir, "values", "hash.json"));
    const result = verifyConformanceManifest(dir);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toContain("values/hash.json");
  });

  test("reports an added file not listed in the manifest", () => {
    const dir = makeCopy();
    fs.writeFileSync(path.join(dir, "values", "extra.json"), "{}");
    const result = verifyConformanceManifest(dir);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toContain("values/extra.json");
  });

  test("reports the actual manifest version separately from the expected one", () => {
    const dir = makeCopy();
    const file = path.join(dir, "manifest.json");
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace('"version": "1.0.0"', '"version": "9.9.9"'),
    );
    const result = verifyConformanceManifest(dir);
    expect(result.version).toBe("9.9.9");
    expect(result.expectedVersion).toBe("1.0.0");
    expect(result.versionMatches).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).not.toContain("version");
  });

  test("fails on invalid UTF-8 in manifest.json", () => {
    const dir = makeCopy();
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      Buffer.from([0x7b, 0xff, 0x7d]),
    );
    expect(() => verifyConformanceManifest(dir)).toThrow("invalid UTF-8");
  });
});
