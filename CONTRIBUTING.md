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

1. A maintainer starts **Bump-Version** (`workflow_dispatch`, inputs `level` and `version`). The job computes the next version from the latest release tag `vX.Y.Z`, pushes the branch `release/vX.Y.Z` with one commit `version up to vX.Y.Z` that changes only the version in `packages/library/package.json`, and opens a pull request with the same title. The pull request body has a preview of the release notes. The job then starts **Review Thread Resolution** for the pull request, so that `Check unresolved comments` is published.
2. CI runs on the pull request, because it is opened with `PERSONAL_ACCESS_TOKEN` (a pull request opened with `GITHUB_TOKEN` starts no `pull_request` workflow). A maintainer squash-merges it after the required checks pass. Merging is the release decision.
3. The push to `main` starts the `Tag the merged version` job of Bump-Version. When the version did not change, or the new version is not a release version `X.Y.Z`, the job does nothing. Otherwise `.github/release-gate.py` checks the merged commit:
   - it is the squash merge of a pull request into `main` from the branch `release/vX.Y.Z` of this repository;
   - it changes only the version in `packages/library/package.json`;
   - the version is greater than the previous version and than the latest release tag;
   - it is reachable from `main`.

   GitHub can take a moment to link a merged commit to its pull request, so the job reads the pull request up to five times, about ten seconds apart. If a check fails, the job fails and nothing is tagged. If all pass, the job tags the merged commit and pushes the tag with `PERSONAL_ACCESS_TOKEN` (a tag pushed with `GITHUB_TOKEN` starts no workflow). Tag jobs run one at a time.
4. The tag push starts **Release**. Releases run one at a time. Release checks that the tag matches the package version, runs the same release gate on the tagged commit, and checks that npm does not have the version yet and that the version is greater than the npm `latest`. Then it builds, checks again that no newer release tag appeared, and publishes to npm with provenance (trusted publishing), and checks that npm serves the version as `latest` with a provenance attestation. After that, the `github-release` job creates the GitHub release `Release vX.Y.Z` with the release notes.

Starting Release by hand with `tag: vX.Y.Z` runs the same checks, but publishes without provenance.

Tag jobs and releases each wait in a concurrency group. GitHub keeps only one waiting run per group: if a third run arrives while one is waiting, GitHub cancels the waiting run. The table below says how to re-run it.

Prerequisites: `PERSONAL_ACCESS_TOKEN` must be able to push branches and tags and to open pull requests in this repository. Other steps use `GITHUB_TOKEN`.

### When a release stops halfway

The order is: version pull request, merge, tag, npm, GitHub release. npm is published only from a tag that passes the release gate, so a published version without a tag cannot happen. To check npm, run `npm view event-store-adapter-js@X.Y.Z version dist-tags dist.attestations`.

| State | How to fix | Safe to re-run? |
|---|---|---|
| Bump-Version failed before the branch was pushed (invalid version, existing tag, existing branch) | Fix the cause and start Bump-Version again. | Yes. Nothing was changed. |
| The branch `release/vX.Y.Z` exists but no pull request was opened | Open the pull request from the branch by hand (title `version up to vX.Y.Z`), or delete the branch and start Bump-Version again. | A second run stops at `Check that the version branch is free` until the branch is deleted. |
| The pull request has no `Check unresolved comments`, also after the branch was updated | Start Review Thread Resolution by hand with `pr_number` set to the pull request. Do this again after each update of the branch, because the status belongs to the head commit. | Yes. |
| The pull request should not be released, or its checks fail | Close the pull request and delete the branch. If `main` moved, update the branch from the pull request page. | Yes. `main` is not changed until the merge. |
| `Tag the merged version` failed with `no pull request is associated` or `could not read the pull requests` | GitHub did not link the commit to its pull request in time, or the API failed. Nothing was tagged. Re-run the failed job. | Yes. |
| `Tag the merged version` failed at another check of the release gate (for example, another pull request changed the version, or the version went down) | Nothing was tagged or published. Restore the version with a pull request. | Not applicable. |
| A tag job or a Release run was cancelled while it waited in its concurrency group | Re-run the cancelled run. | Yes. The checks run again. |
| The version is on `main` but there is no tag (`Tag the merged version` failed after the gate, or did not run) | Re-run the failed job of that Bump-Version run. If there is no run, push the tag on the merged commit by hand: `git tag -a vX.Y.Z <merged commit> -m vX.Y.Z` and `git push origin vX.Y.Z`. Release runs the release gate on it, so a tag on any other commit is not published. Do not open the next version pull request before this is fixed. | Yes. The job does nothing when the tag is already on the same commit. |
| The tag exists but no Release run started | If npm does not have the version, delete the remote tag (`git push origin :refs/tags/vX.Y.Z`) and re-run `Tag the merged version`; the new tag push publishes with provenance. Starting Release by hand with `tag: vX.Y.Z` also works, but without provenance. | Yes, while npm does not have the version. |
| The tag exists but npm does not have the version (Release failed before `publish`) | Re-run the failed jobs of that Release run. This keeps the tag-push event, so the package keeps its provenance. | Yes. |
| Release failed at or after `publish` | Check npm. If npm does not have the version, re-run the failed jobs. If npm has it, a re-run stops at `Check that the version is not on npm yet` on purpose: check that the provenance is there and look at `dist-tags.latest`. Only when `latest` is older than this version, fix it with `npm dist-tag add event-store-adapter-js@X.Y.Z latest`; when a newer version is already `latest`, leave it. Then create the GitHub release by hand with `gh release create vX.Y.Z --verify-tag --title "Release vX.Y.Z"` and the notes from `.github/create-release-note-header.py` and `.github/create-release-note-body.py`. | A re-run never publishes twice. |
| The version is on npm but there is no GitHub release (`github-release` failed) | Re-run the failed jobs of that Release run (only `github-release` runs again). The previous tag is the highest release tag below the version, so it does not need to be an ancestor; without one, the notes start at the first commit. | Yes. The job does nothing when the release exists. |

Japanese version: [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md)
