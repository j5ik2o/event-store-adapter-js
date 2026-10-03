#!/bin/sh
# TAKT を、claude のアカウントを指定して起動する。
#
#   scripts/run-takt.sh --claude-account <設定ディレクトリ> [takt の引数...]
#   例: scripts/run-takt.sh --claude-account ~/.claude-work --pipeline --auto-pr -b fix/x -i 9 --workflow spark-preparation
#
# TAKT_CLAUDE_CLI_PATH に scripts/takt-claude.sh を絶対パスで渡し、TAKT が起動する claude を、
# 指定したアカウント (CLAUDE_CONFIG_DIR) で動かす。アカウントの上限に当たったときに、
# 別のアカウントへ切り替えて再開するために使う。アカウントの名前はマシンごとの事情なので、
# リポジトリには書かず、起動のたびに指定する。--claude-account の後ろの引数は、そのまま takt に渡す。
set -eu

usage() {
    echo "usage: scripts/run-takt.sh --claude-account <設定ディレクトリ> [takt の引数...]" >&2
    exit 2
}

[ "$#" -ge 2 ] || usage
[ "$1" = "--claude-account" ] || usage
account_dir=$2
shift 2

if [ ! -d "$account_dir" ]; then
    echo "run-takt: アカウントの設定ディレクトリがない: $account_dir" >&2
    exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TAKT_CLAUDE_CLI_PATH=$script_dir/takt-claude.sh
TAKT_CLAUDE_ACCOUNT_DIR=$(CDPATH= cd -- "$account_dir" && pwd)
export TAKT_CLAUDE_CLI_PATH TAKT_CLAUDE_ACCOUNT_DIR

# TAKT は TAKT_ANTHROPIC_API_KEY を claude の認証に使い、起動する claude に ANTHROPIC_API_KEY として渡す。
# 呼び出し元に別のアカウントのキーが残っていると、指定したアカウントで動く保証がなくなるので外す。
unset TAKT_ANTHROPIC_API_KEY

echo "run-takt: claude のアカウント設定: $TAKT_CLAUDE_ACCOUNT_DIR" >&2
exec "${TAKT_REAL_CLI:-takt}" "$@"
