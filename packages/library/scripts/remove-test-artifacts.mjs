import { access, readdir, rm } from "node:fs/promises";
import path from "node:path";

const distPath = path.resolve("dist");
const tsconfigPath = path.resolve("tsconfig.json");
const testSupportPath = path.join(distPath, "internal", "test");

await access(distPath).catch((error) => {
  throw new Error(`Build output directory not found: ${distPath}: ${error.message}`);
});

const collectTestArtifacts = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw new Error(`Failed to read directory ${directory}: ${error.message}`);
  });
  const nestedArtifacts = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectTestArtifacts(entryPath);
      }
      if (entry.name.endsWith(".test.d.ts") || entry.name.endsWith(".test.js")) {
        return [entryPath];
      }
      return [];
    }),
  );
  return nestedArtifacts.flat();
};

const removeFiles = async (files) => {
  await Promise.all(files.map((file) => rm(file, { force: true })));
};

await removeFiles(await collectTestArtifacts(distPath));
await rm(testSupportPath, { force: true, recursive: true });

const remainingArtifacts = await collectTestArtifacts(distPath);
if (remainingArtifacts.length > 0) {
  throw new Error(
    `Build output still contains test artifacts after cleanup: ${remainingArtifacts.join(", ")}. ` +
      `Verify that ${tsconfigPath} excludes test files and that the build cleanup ran successfully.`,
  );
}
