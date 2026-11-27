#!/usr/bin/env bash
# release_path.qnt（rs の写し）と release_path_js.qnt（js の instance）の検査を流す。
# 使い方:
#   bash .github/quint/run-quint.sh ci          CI 用：typecheck、quint test（jsPathsTest と、写しの confirmBoundaryTest）、
#                                               違反なしを期待する js（safety と neverTimesOutAfterPublished）と、違反を期待する4つの
#                                               quint run（500 サンプル）。ほかの言語のインスタンスの乱数の試行は full だけ
#   bash .github/quint/run-quint.sh full [N]    全 instance を N サンプル（既定 3000）で流す。モデルを変えた PR で手元で流し、結果を PR に書く
# 環境変数 QUINT：quint のコマンド（既定 quint）。CI は npx で版を固定して使う。
set -euo pipefail
cd "$(dirname "$0")"
# 結果の行（[ok]・[violation]）を先頭から読むので、色の付いた出力にしない（FORCE_COLOR=1 の環境でも）
export FORCE_COLOR=0 NO_COLOR=1
read -r -a Q <<< "${QUINT:-quint}"
mode="${1:-ci}"
SEED=7
STEPS=30
# release_path_js.qnt にある instance。ほかは release_path.qnt にある
JS_INSTANCES=" js jsShortConfirm jsReleaseNotGated "
# 「instance:不変条件」の組
POSITIVE_ALL=(java:safety javaReleasesOnly:safety kotlin:safety kotlinNoManual:safety kotlinReleasesOnly:safety scala:safety
  scalaNoManual:safety scalaReleasesOnly:safety rs:safety rsNoManual:safety rsReleasesOnly:safety rsNoLatestTagCheck:safety
  rsVisibleLatest:safety go:safety javaR2aOnly:safety scalaBeforeR5:safety javaR2b:safety javaR2bReleasesOnly:safety
  java:neverTimesOutAfterPublished js:safety js:neverTimesOutAfterPublished)
# 前提を外すと破れることを示す instance と、破れる不変条件
NEGATIVE_ALL=(kotlinNoRequired:legacyBeforeNewer scalaNoRequired:legacyBeforeNewer goManualTags:publishedOnlyFromReleasePR
  jsBefore1161:neverTimesOutAfterPublished wholeRerun:noDuplicatePublish noDeploymentCheck:noDuplicatePublish
  javaR2aPushesTags:noDuplicatePublish scalaOldBumpLive:legacyBeforeNewer noOtherDeploymentCheck:publishedMonotonic
  stepRecordDropped:noDuplicatePublish unknownIgnored:noDuplicatePublish noneSkipsQuery:noDuplicatePublish
  noneSkipsQuery:publishedMonotonic noLatestTagCheck:publishedMonotonic
  cancelledLeftAlone:stopsAreRecoverable cancelledLeftAlone:untaggedReleaseRecoverable
  rsNoPrecheck:noDuplicatePublish rsNoLatestCheck:publishedMonotonic rsShortConfirm:neverTimesOutAfterPublished rsReleaseNotGated:releaseOnlyAfterConfirmed
  jsShortConfirm:neverTimesOutAfterPublished jsReleaseNotGated:releaseOnlyAfterConfirmed)
POSITIVE_CI=(js:safety js:neverTimesOutAfterPublished)
NEGATIVE_CI=(jsBefore1161:neverTimesOutAfterPublished jsShortConfirm:neverTimesOutAfterPublished
  jsReleaseNotGated:releaseOnlyAfterConfirmed cancelledLeftAlone:stopsAreRecoverable)
# 「ファイル:module」の組
TESTS_CI=(release_path_js_test.qnt:jsPathsTest release_path_test.qnt:confirmBoundaryTest)
TESTS_ALL=("${TESTS_CI[@]}" release_path_test.qnt:rsPathsTest release_path_test.qnt:javaPathsTest
  release_path_test.qnt:kotlinPathsTest release_path_test.qnt:scalaPathsTest release_path_test.qnt:javaR2aOnlyTest
  release_path_test.qnt:javaR2bPathsTest release_path_test.qnt:tagRecoveryTest)

if [[ "$mode" == ci ]]; then
  samples=500
  positive=("${POSITIVE_CI[@]}")
  negative=("${NEGATIVE_CI[@]}")
  tests=("${TESTS_CI[@]}")
elif [[ "$mode" == full ]]; then
  samples="${2:-3000}"
  positive=("${POSITIVE_ALL[@]}")
  negative=("${NEGATIVE_ALL[@]}")
  tests=("${TESTS_ALL[@]}")
else
  echo "usage: run-quint.sh ci|full [samples]" >&2
  exit 2
fi

model_file() {
  if [[ "$JS_INSTANCES" == *" $1 "* ]]; then
    echo release_path_js.qnt
  else
    echo release_path.qnt
  fi
}

failed=0
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
for file in release_path.qnt release_path_test.qnt release_path_js.qnt release_path_js_test.qnt; do
  "${Q[@]}" typecheck "$file"
done
echo "typecheck: ok"
for item in "${tests[@]}"; do
  file="${item%%:*}"
  main="${item#*:}"
  echo "## quint test ${main}"
  "${Q[@]}" test "$file" --main="$main" || failed=1
done
for item in "${positive[@]}"; do
  main="${item%%:*}"
  invariant="${item#*:}"
  echo "## ${main}  invariant=${invariant}  (expect: no violation)"
  if "${Q[@]}" run "$(model_file "$main")" --main="$main" --invariant="$invariant" --max-samples="$samples" \
    --max-steps="$STEPS" --seed="$SEED" > "$log" 2>&1 && grep -qE '^\[ok\]' "$log"; then
    grep -E '^\[ok\]' "$log"
  else
    tail -n 40 "$log"
    failed=1
  fi
done
for item in "${negative[@]}"; do
  main="${item%%:*}"
  invariant="${item#*:}"
  echo "## ${main}  invariant=${invariant}  (expect: violation)"
  # 反例は、非ゼロの終了と [violation] の両方。実行時の誤り（[error]）は反例と数えず、診断を出して失敗にする
  if ! "${Q[@]}" run "$(model_file "$main")" --main="$main" --invariant="$invariant" --max-samples="$samples" \
    --max-steps="$STEPS" --seed="$SEED" > "$log" 2>&1 && grep -qE '^\[violation\]' "$log"; then
    grep -E '^\[violation\]' "$log"
  else
    echo "expected a violation of ${invariant} in ${main}, found none"
    tail -n 40 "$log"
    failed=1
  fi
done
exit "$failed"
