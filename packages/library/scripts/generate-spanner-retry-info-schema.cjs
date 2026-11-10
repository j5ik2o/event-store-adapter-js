const fs = require("node:fs");
const path = require("node:path");
const descriptor = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const google = descriptor.nested.google.nested;
const schema = { nested: { google: { nested: {
  rpc: { nested: { RetryInfo: google.rpc.nested.RetryInfo } },
  protobuf: { nested: { Duration: google.protobuf.nested.Duration } },
} } } };
fs.writeFileSync(path.join(__dirname, "../src/internal/spanner-retry-info-schema.ts"),
  "// Generated from @google-cloud/spanner 9.1.0 build/protos/status.json.\n" +
  "// Copyright Google LLC. Apache-2.0. See docs/third-party/spanner-retry-info.md.\n" +
  `export const retryInfoSchema = ${JSON.stringify(schema, null, 2)};\n`);
