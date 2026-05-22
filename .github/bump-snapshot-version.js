const fs = require("node:fs");

const packageJsonPath = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = packageJson.version;
const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-snapshot\.(\d+))?$/);

if (!match) {
  throw new Error(`Unsupported package version: ${version}`);
}

const major = Number(match[1]);
const minor = Number(match[2]);
const patch = Number(match[3]);
const snapshot = match[4] === undefined ? undefined : Number(match[4]);

const nextVersion =
  snapshot === undefined
    ? `${major}.${minor}.${patch + 1}-snapshot.0`
    : `${major}.${minor}.${patch}-snapshot.${snapshot + 1}`;

packageJson.version = nextVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(nextVersion);
