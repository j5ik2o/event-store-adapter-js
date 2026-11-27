# Release path model (Quint)

`release_path.qnt` models the release path: the version pull request, the merge, the release gate, the tag, the publish job, the publish target, the checks after publishing and the GitHub release. `release_path_test.qnt` runs fixed paths through the model.

`release_path.qnt` and `release_path_test.qnt` are copies of `.github/quint/` in j5ik2o/event-store-adapter-rs at `bde9f7f`, byte for byte, so that the model stays the same in every repository until it moves to a shared source. Check them with:

```sh
shasum -a 256 .github/quint/release_path.qnt .github/quint/release_path_test.qnt
# 584ec970a94f51851d67f172030065801822a844f930fe4eac2bf4bb603a5383  release_path.qnt
# 3676c44f26e591eb6cca4dfbd6c3ba323a99812ef695aaaf1bac2e925eae7c69  release_path_test.qnt
```

The js parts are in their own files, which import the model with `from "./release_path"`:

- `release_path_js.qnt`: the instances of `.github/workflows/release.yml` after j5ik2o/event-store-adapter-js#1161.
- `release_path_js_test.qnt`: `jsPathsTest`, the fixed js paths.

## The js instances

One clock tick is 60 seconds (one check). The instance `jsBefore1161` in `release_path.qnt` counts 10-second ticks; it is the shape before #1161 (6 checks 10 seconds apart, about 3 minutes of delay).

- `js`: the `confirm` job waits up to `CONFIRM_ATTEMPTS = 10` ticks (600 seconds). The real wait is 900 seconds; a longer wait only removes timeouts, so the model is the stricter case. The delay is up to `MAX_DELAY = 9` ticks (540 seconds): the origin delay of v5.3.0 (about 190 seconds) plus the CDN cache of the packument (`max-age=300`). `RELEASE_AFTER_CONFIRM = true`: `github-release` needs a successful `confirm`. The precheck is assumed to see a published version (`PRECHECK_SEES_DEPLOYMENTS = true`); `jsPrecheckMisses` checks the path where it does not. The npm `latest` lags (`PRECHECK_ACCEPTED_LATEST = false`), and `final_tag_check` checks the latest tag (`PRECHECK_LATEST_TAG = true`). Expected: no violation of `safety` and of `neverTimesOutAfterPublished`.
- `jsShortConfirm`: a delay of 12 ticks, longer than the wait. Expected: a violation of `neverTimesOutAfterPublished`. It shows that 30 steps reach a timeout, so the check of `js` is not empty.
- `jsReleaseNotGated`: the confirm gate is removed on purpose, so `github-release` does not wait for `confirm`. This is not the shape before #1161: there, a timeout of `npm_after` failed the `release` job, so `github-release` did not run (`jsBefore1161` models the wait of that shape). Expected: a violation of `releaseOnlyAfterConfirmed`.
- `jsPrecheckMisses`: `npm view` in `npm_before` reads a delayed value, so the precheck can miss a published version (`PRECHECK_SEES_DEPLOYMENTS = false`). When the `release` job fails after the publish and is re-run, it can then try to publish again, and npm refuses. In the model, `submit` refuses a version that is already published and counts the try in `duplicateAttempts`. Expected: no violation of `publishedMonotonic` (no version is published twice), and a violation of `noDuplicatePublish`, which shows that the check reaches that path. The rest of `safety` is not checked here: in the copied model, a refused try ends the job as if it succeeded, so `publishedReleaseRecoverable` fails. In the real workflow, the refused publish fails the job, `npm_before` stops a re-run, and CONTRIBUTING gives the steps by hand. Modelling that needs a new constant in the copied model, which is changed in the rs repository first.
- `jsPathsTest`: a release within the wait, a release refused while `confirm` waits, a timeout recovered by re-running only the failed jobs (`confirm`, then `github-release`) with one publish, a second publish refused by npm after the precheck missed the version (`PRECHECK_SEES_DEPLOYMENTS = false`, as in `jsPrecheckMisses`), and two releases in a row.

How the jobs map to the model: the `release` job is `publishJob` (up to the publish). The `confirm` job is `confirmPoll`, and re-running it is `rerunConfirm`. The `github-release` job is `githubRelease`. Outside the model: the provenance, a manual start without provenance, a `latest` newer than the version, and which release is GitHub's Latest; the tests in `.github/tests/` check them. The copied model lets a re-run `release` job end with success when the precheck reads the version as published (`resumePublishJob`); the real `npm_before` stops with an error instead, and CONTRIBUTING gives the steps by hand.

## Running

```sh
bash .github/quint/run-quint.sh ci          # what CI runs: typecheck, jsPathsTest and confirmBoundaryTest, js with two invariants, jsPrecheckMisses with one, 5 negative checks with 500 samples
bash .github/quint/run-quint.sh full 3000   # every instance; run it locally when the model changes and put the result in the pull request
```

The script uses `quint` from `PATH`, or the command in `QUINT` (CI uses `npx --yes @informalsystems/quint@0.32.0`).

quint fetches its Rust evaluator (`evaluator/v0.6.0`) from the GitHub API without authentication when `$QUINT_HOME/rust-evaluator-v0.6.0/quint_evaluator` is missing (`QUINT_HOME` defaults to `~/.quint`). That API allows 60 requests an hour per IP, which shared runners often have used up. CI therefore runs `fetch-evaluator.sh` (copied from the rs repository) first: it downloads the evaluator with `gh` and the job's token, checks its SHA-256, and puts it in `$QUINT_HOME`.

When `release.yml` or `npm-registry.py` changes what it decides, change the model first, then the code.
