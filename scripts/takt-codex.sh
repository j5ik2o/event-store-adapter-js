#!/bin/sh
# TAKT の Codex SDK が起動する Codex CLI の入口。
# TAKT_CODEX_ACCOUNT_DIR でアカウントごとの CODEX_HOME を選ぶ。
set -eu

account_dir=${TAKT_CODEX_ACCOUNT_DIR:-}
if [ -z "$account_dir" ]; then
    echo "takt-codex: TAKT_CODEX_ACCOUNT_DIR が必要です" >&2
    exit 1
fi
if [ ! -d "$account_dir" ]; then
    echo "takt-codex: Codex の設定ディレクトリがない: $account_dir" >&2
    exit 1
fi

# 選択した ChatGPT アカウントを確実に使う。API key が残っていると CODEX_HOME
# の OAuth 認証より優先されるため、明示的な account 選択時は取り除く。
unset OPENAI_API_KEY CODEX_API_KEY
CODEX_HOME=$account_dir
export CODEX_HOME
TAKT_AGENT=1
export TAKT_AGENT
exec "${TAKT_CODEX_REAL_CLI:-codex}" "$@"
