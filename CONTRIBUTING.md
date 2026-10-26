# Contributing to event-store-adapter-js

## Overview

This guide is for developers who change this repository. For using the library, see [README.md](README.md) and [packages/library/README.md](packages/library/README.md).

The repository is a pnpm workspace with three packages:

- `packages/library`: the published library (`event-store-adapter-js`)
- `packages/examples`: runnable examples
- `packages/tests`: tests that consume the built and packed library

## Shared contract and decisions

The contract shared by all language implementations and the decisions behind it are kept in the hub repository, j5ik2o/event-store-adapter:

- Specifications: <https://github.com/j5ik2o/event-store-adapter/tree/main/docs/spec>
- Architecture decision records: <https://github.com/j5ik2o/event-store-adapter/tree/main/docs/adr>

`conformance/` and `api-surface/surface.json` are copies of files from the hub, and CI verifies them against fixed SHA-256 values. Do not edit them in this repository.

## Local setup

- Node.js 24 or later (`engines` in `package.json`; `.mise.toml` sets `node = "24"`).
- pnpm 12.15.0 (`packageManager` in `package.json`). CI enables it with `corepack enable`.
- Install dependencies the same way CI does:

```shell
corepack enable
pnpm install --frozen-lockfile
```

- Docker is required for the DynamoDB and Spanner tests and for the DynamoDB examples (see [packages/library/README.md](packages/library/README.md)).
- Python 3 is required for the documentation and conformance data checks. `tools/user-docs/check.py` requires Python 3.10 or later.

## Checks

Run these from the repository root. These are the main commands CI runs.

| CI job | Command |
|:--|:--|
| `lint` | `pnpm run lint` |
| `test` | `pnpm run build`, then `pnpm --filter event-store-adapter-js run coverage --runInBand` |
| `examples` | `pnpm run test:examples` |
| `package-tests` | `pnpm run test:packages` |
| `release-checks` | `python3 tools/conformance/manifest.py verify`, `sha256sum -c` against the fixed SHA-256 values listed in `.github/workflows/ci.yml`, `python3 tools/user-docs/check.py`, `python3 -m unittest discover -s .github/tests -v` (needs `pip install semver`), and `actionlint` (installed with `go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12`) |

Other root scripts: `pnpm run test` runs the library tests, and `pnpm run fmt` and `pnpm run fix` format and fix the library sources with Biome.

When a change touches only documentation files (`*.md`, `docs/*`, `README*` and similar), the code check jobs are skipped, and `release-checks` always runs.

## Design history

[docs/design/next-major.md](docs/design/next-major.md) ([Japanese](docs/design/next-major.ja.md)) is the design record written while building v5. For current usage, check the README and the current code. `openspec/` and `.kiro/` hold historical generated files.

## Changes and releases

- Open pull requests against `main`.
- Write commit subjects in the Conventional Commits form (`type(scope): description`). The next version level and the release notes are derived from them.
- Versions are bumped by the manually started Bump-Version workflow. Do not change the version in `packages/library/package.json` in a pull request.
- Pushing a tag `vX.Y.Z` starts the Release workflow, which publishes the library to npm.
- The Snapshot workflow publishes with the `snapshot` dist-tag only after successful CI triggered by a push to `main` or a schedule, for the same commit while it is still the tip of `main` immediately before publishing.

Japanese version: [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md)
