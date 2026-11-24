#!/usr/bin/env bash
# 関門 (release-gate.py check) にかける事実を、指定のディレクトリに書く。
# 使い方: release-gate-inputs.sh <コミット> <出力先>
# 環境変数: GH_TOKEN、GITHUB_REPOSITORY、PULLS_RETRY_SECONDS（既定 10。PR の照会を再試行する間隔）
set -euo pipefail

sha="$1"
out="$2"
mkdir -p "$out"

git fetch --no-tags origin main
on_main=false
if git merge-base --is-ancestor "$sha" FETCH_HEAD; then
  on_main=true
fi
echo "$on_main" > "${out}/on-main"
git show "${sha}^:packages/library/package.json" > "${out}/parent.json"
git show "${sha}:packages/library/package.json" > "${out}/package.json"
git diff --name-only "${sha}^" "$sha" > "${out}/changed-files"
git ls-remote --tags origin > "${out}/remote-tags"

# マージの直後は、コミットと PR の関連付けがまだ返らないことがある。一時的な失敗と空の応答だけを数回やり直す。
attempts=5
read_ok=false
for attempt in $(seq 1 "$attempts"); do
  if gh api "repos/${GITHUB_REPOSITORY}/commits/${sha}/pulls" > "${out}/pulls.json"; then
    read_ok=true
    if [[ "$(tr -d '[:space:]' < "${out}/pulls.json")" != "[]" ]]; then
      break
    fi
    echo "no pull request is associated with ${sha} yet (${attempt}/${attempts})"
  else
    read_ok=false
    echo "could not read the pull requests of ${sha} (${attempt}/${attempts})"
  fi
  if [[ "$attempt" -lt "$attempts" ]]; then
    sleep "${PULLS_RETRY_SECONDS:-10}"
  fi
done
if [[ "$read_ok" != true ]]; then
  echo "::error::could not read the pull requests of ${sha}; re-run the job"
  exit 1
fi
