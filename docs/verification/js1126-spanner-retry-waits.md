# JS #1126 verification

The implementation follows all JS requirements of common ADR 0009 D1-D8 at `ea561f8d2a1d008a9196e8b189268741fbc0c9ff`. The source base is JS `4f4f5b800aea89b7e880a77cc90d76929dc889bc`. Work used fixed GitHub source archives under `/tmp/pm-js1126-backoff/`, without git checkout, init, clone, worktree, or shared repository mutation. PR1125 was not reused. `scope.md` and the entry/decoder sketch were saved before implementation.

## New execution evidence

Node 26.13.0 and pnpm 12.18.0 ran these checks on 2026-11-11.

- `pnpm install --frozen-lockfile`, `pnpm lint`, and `pnpm build` passed. Build includes strict TypeScript checks. Existing Biome schema-version and deprecated-field information remains unchanged.
- `pnpm --filter event-store-adapter-js run coverage --runInBand` passed 118 suites and 3100 tests, including emulator-backed and other-backend tests. This run began before the final test additions. The final focused coverage run passed 63 tests across the transaction, retry-wait, and persist-event suites. Retry-wait statement, branch, function and line coverage were all 100% in the focused run.
- A final additional local selection passed 100 suites and 2230 tests.
- The first `pnpm test:packages` run hit Docker port-binding timeouts before its DynamoDB scenarios could run. This is not counted as a pass. The sequential rerun passed all 15 package tests, including built Memory, DynamoDB, SQLite and Bigtable usage.
- `pnpm test:examples` passed typecheck, three domain tests, memory and DynamoDB examples.
- `python3 tools/conformance/manifest.py verify` passed 35 files at version 1.4.0. `python3 tools/user-docs/check.py` passed 20 documents at template 1.0.0.
- `pnpm licenses list --json` completed. The directly declared runtime is protobufjs 7.6.6, BSD-3-Clause. The retained Spanner Apache-2.0 license matches the SDK's full license bytes. The lockfile changes only the direct importer entry, reusing its existing runtime resolution.

The fixed original entry was transpiled separately with the same fake database and injected clock used for the changed entry. Both returned success after two attempts. The original produced `waits=[]`, failing the expected 25ms wait. The changed entry produced `waits=[25]`, passing that assertion. The local executable and output are `entry-control.cjs` and `entry-control.log` in the work directory.

`node packages/library/scripts/verify-spanner-retry-peers.cjs` independently installed SDK 8.7.1 and 9.1.0 with the explicit protobuf runtime. It copied the built adapter into each isolated dependency tree. Each SDK's actual descriptor encoded 13 metadata cases. The actual gRPC Metadata implementation carried these bytes through the current transaction entry. Both passed duration rounding, zero versus missing, malformed data, invalid and out-of-range durations, lossless large seconds, unknown fields, long-hint stopping, first-valid ordering and cleanup-before-wait. This is real SDK wire/metadata integration with fake transactions, rather than a live backend test or a claim based on the workspace lockfile.

Descriptor SHA-256 values were `333df11e875e7414059eac036124d1c575c12b783233370a1b09cc22654092d0` for SDK 8.7.1 `build/protos/protos.json` and `5b20d93e4c0d02af64cfecbb591fd90bd2adbe4e1f5835bf244d78adbc51ede7` for SDK 9.1.0 `build/protos/status.json`.

Focused tests cover retryLimit 0, 1 and 5, exhaustion before metadata/random/timer, fallback endpoints through a huge retry ordinal, exact duration boundaries and malformed representations, early timer wakes and monotonic re-reservation, referenced production timers, cleanup and hook order, rollback rejection, end throw precedence, sleeper rejection, numeric-code classification, acquisition failures, ABORTED-shaped afterCommit failure, domain rejection, fresh transaction acquisition, identical append parameters and sequence number, head recheck and concurrent-head conflict, and success effects exactly once.

## Reproduce

From a source archive of this PR head, run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm build`, and `pnpm --filter event-store-adapter-js run coverage --runInBand`. Full backend suites and package tests require Docker. Run `pnpm test:examples` and `pnpm test:packages` for examples and packed API checks. Run the peer script above after build. It needs npm registry access and preserves its isolated installation paths in its JSON output. Run the conformance and user-docs commands above. Verify the major implementation manifest with `shasum -a 256 -c docs/verification/js1126-manifest.sha256`.

Archive SHA-256 values from this run were `1e0c92d4d83b9c8344c145149f71daf3fb9b9343941f70b21b91d765b62c5d1f` for the JS source archive and `edca78ea41ad3b45772af307e7dbc605356e9352c303de7e790d3f8d0232c146` for the common source archive. Archive transport hashes are recorded separately from the fixed commit identities and file manifest.

## Limits and handoff

No real Spanner service, production contention, performance improvement, starvation or priority continuity was measured. The peer gate proves encoded metadata and entry behavior using fake transactions. Abandoning a Promise or racing it with a timeout has no retry cancellation guarantee. No new AbortSignal, total deadline, automatic runner or session/transaction priority continuity was added.

Additional agents and watchers were prohibited. Exploration and comment/diff checks were sequential self-checks. No independent review verdict is claimed. PM must obtain an independent review of the final head and decide merge and Snapshot publication separately. No release, workflow, version, tag, publication, merge or force push was performed.
