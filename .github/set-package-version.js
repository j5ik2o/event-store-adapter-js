const fs = require("node:fs");
const path = require("node:path");

const nextVersion = process.argv[2];
if (!nextVersion) {
  throw new Error("Usage: node .github/set-package-version.js <version>");
}
if (!/^\d+\.\d+\.\d+(?:-snapshot\.\d+)?$/.test(nextVersion)) {
  throw new Error(
    `Unsupported version format: ${nextVersion}. Expected X.Y.Z or X.Y.Z-snapshot.N`,
  );
}

const packageJsonPath = path.join(
  __dirname,
  "..",
  "packages",
  "library",
  "package.json",
);
if (!fs.existsSync(packageJsonPath)) {
  throw new Error(`Missing ${packageJsonPath}`);
}

let packageJson;
try {
  packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
} catch (error) {
  throw new Error(`Failed to read ${packageJsonPath}: ${error.message}`);
}

packageJson.version = nextVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(nextVersion);
