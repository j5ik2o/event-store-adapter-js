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

- Docker is required for the DynamoDB, Spanner and Bigtable tests and for the DynamoDB examples (see [packages/library/README.md](packages/library/README.md)). The SQLite tests use local files only and need no Docker, but they need Node.js 24.15 or later, whose bundled `node:sqlite` provides SQLite 3.51.3 or later.
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
- Versions are bumped by the manually started Bump-Version workflow, which opens a version pull request. Do not change the version in `packages/library/package.json` in any other pull request: merging a version change into `main` starts a release.
- Pushing a tag `vX.Y.Z` starts the Release workflow, which publishes the library to npm.
- Builds from `main` are not published. Install a released version from npm. Between releases, the version on `main` is the last released version (older `main` commits carry a `-snapshot.N` suffix).

### Release flow

`main` is protected (required checks `CI Success` and `Check unresolved comments`, also for administrators), so no workflow pushes to `main`.

1. A maintainer starts **Bump-Version** (`workflow_dispatch`, inputs `level` and `version`). The job computes the next version, pushes the branch `release/vX.Y.Z` with one commit `version up to vX.Y.Z` that changes only `packages/library/package.json`, and opens a pull request with the same title. The pull request body has a preview of the release notes. The job then starts **Review Thread Resolution** for the pull request, so that `Check unresolved comments` is published.
2. CI runs on the pull request, because it is opened with `PERSONAL_ACCESS_TOKEN` (a pull request opened with `GITHUB_TOKEN` starts no `pull_request` workflow). A maintainer squash-merges it after the required checks pass. Merging is the release decision.
3. The push to `main` starts the `Tag the merged version` job of Bump-Version. `.github/release-trigger.py` compares the version before and after the push. It tags the merged `main` commit only when the version changed, is a release version `X.Y.Z`, has no tag yet, and is greater than the latest tag. It pushes the tag with `PERSONAL_ACCESS_TOKEN` (a tag pushed with `GITHUB_TOKEN` starts no workflow).
4. The tag push starts **Release**: it checks that the tag matches the package version, builds, and publishes to npm with provenance (trusted publishing). After the publish succeeds, the `github-release` job creates the GitHub release `Release vX.Y.Z` with the release notes.

Prerequisites: `PERSONAL_ACCESS_TOKEN` must be able to push branches and tags and to open pull requests in this repository.

### When a release stops halfway

Every step either finishes or leaves one of the states below. The order is: version pull request, merge, tag, npm, GitHub release. npm is published only from a tag, so a published version without a tag cannot happen.

| State | How to fix | Safe to re-run? |
|---|---|---|
| Bump-Version failed before the branch was pushed (invalid version, existing tag, existing branch) | Fix the cause and start Bump-Version again. | Yes. Nothing was changed. |
| The branch `release/vX.Y.Z` exists but no pull request was opened | Open the pull request from the branch by hand (title `version up to vX.Y.Z`), or delete the branch and start Bump-Version again. | A second run stops at `Check that the version branch is free` until the branch is deleted. |
| The pull request has no `Check unresolved comments` | Start Review Thread Resolution by hand with `pr_number` set to the pull request. | Yes. |
| The pull request should not be released, or its checks fail | Close the pull request and delete the branch. If `main` moved, update the branch from the pull request page. | Yes. `main` is not changed until the merge. |
| The version is on `main` but there is no tag (`Tag the merged version` failed) | Re-run the failed job of that Bump-Version run. If there is no run, push the tag by hand: `git tag -a vX.Y.Z <merged commit> -m vX.Y.Z` and `git push origin vX.Y.Z`. Do not open the next version pull request before this is fixed. | Yes. The job does nothing when the tag exists. |
| The tag exists but the version is not on npm (Release failed before or during `publish`) | Re-run the failed jobs of that Release run. This keeps the tag-push event, so the package keeps its provenance. Starting Release by hand with `tag: vX.Y.Z` also works, but publishes without provenance. | Yes. npm refuses to publish the same version twice. |
| The version is on npm but there is no GitHub release (`github-release` failed) | Re-run the failed jobs of that Release run (only `github-release` runs again). | Yes. The job does nothing when the release exists. |
| `Tag the merged version` failed with `must be greater than the latest tag` | The merged version is not newer than the latest tag. Revert the merge with a pull request; nothing was tagged or published. | Not applicable. |

Japanese version: [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md)
