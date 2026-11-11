# RetryInfo decoder provenance

`src/internal/spanner-retry-info-schema.ts` contains only the RetryInfo and Duration descriptors from `@google-cloud/spanner@9.1.0/build/protos/status.json`. Google LLC distributes these descriptors under Apache-2.0. The full upstream license is in [spanner-LICENSE](spanner-LICENSE).

The adapter constructs its own decoder with the directly declared `protobufjs@7.6.6` runtime, distributed under BSD-3-Clause. No SDK private helper or runtime descriptor is imported by the adapter. The runtime's package retains its license. The schema uses protobufjs's lossless Long-to-string conversion before BigInt arithmetic.

To reproduce the schema, extract `nested.google.nested.rpc.nested.RetryInfo` and `nested.google.nested.protobuf.nested.Duration` from the fixed SDK descriptor, preserving their namespaces under `nested.google.nested`. Emit that object as `export const retryInfoSchema` and format with Biome. `scripts/verify-spanner-retry-peers.cjs` independently loads each installed SDK descriptor to encode actual wire messages for the adapter.

Run `node scripts/generate-spanner-retry-info-schema.cjs /path/to/spanner-9.1.0/build/protos/status.json` from the library package, then `pnpm exec biome check --write src/internal/spanner-retry-info-schema.ts`. The generator accepts the fixed SDK descriptor path explicitly and adds no generator dependency.
