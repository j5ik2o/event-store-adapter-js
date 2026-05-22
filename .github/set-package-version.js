const fs = require("node:fs");

const nextVersion = process.argv[2];
if (!nextVersion) {
  throw new Error("Usage: node .github/set-package-version.js <version>");
}

const packageJsonPath = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
packageJson.version = nextVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(nextVersion);
