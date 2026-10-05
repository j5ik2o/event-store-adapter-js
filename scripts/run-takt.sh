#!/bin/sh
# TAKT を、claude と codex のアカウントを指定して起動する。
#
#   scripts/run-takt.sh --claude-account <設定ディレクトリ> --codex-account <設定ディレクトリ> [takt の引数...]
#   例: scripts/run-takt.sh --claude-account ~/.claude-work --codex-account ~/.codex-work --pipeline --auto-pr -b fix/x -i 9 --workflow flash-default
#
# runtime.yaml は 1 回の実行で claude と codex の両方を使う。TAKT_CLAUDE_CLI_PATH に scripts/takt-claude.sh、
# TAKT_CODEX_CLI_PATH に scripts/takt-codex.sh を絶対パスで渡し、TAKT が起動する claude と codex を、
# それぞれ指定したアカウント (CLAUDE_CONFIG_DIR、CODEX_HOME) で動かす。codex の設定は run-codex.sh と同じ。
# アカウントの上限に当たったときに、別のアカウントへ切り替えて再開するために使う。アカウントの名前は
# マシンごとの事情なので、リポジトリには書かず、起動のたびに指定する。TAKT の設定はカレントディレクトリの
# プロジェクトの .takt/home から読む (TAKT_CONFIG_DIR)。アカウントの指定の後ろの引数は、そのまま takt に渡す。
set -eu

usage() {
    echo "usage: scripts/run-takt.sh --claude-account <設定ディレクトリ> --codex-account <設定ディレクトリ> [takt の引数...]" >&2
    exit 2
}

claude_account=
codex_account=
while [ "$#" -gt 0 ]; do
    case $1 in
        --claude-account)
            [ "$#" -ge 2 ] || usage
            claude_account=$2
            shift 2
            ;;
        --codex-account)
            [ "$#" -ge 2 ] || usage
            codex_account=$2
            shift 2
            ;;
        *)
            break
            ;;
    esac
done
[ -n "$claude_account" ] || usage
[ -n "$codex_account" ] || usage

if [ ! -d "$claude_account" ]; then
    echo "run-takt: claude のアカウント設定ディレクトリがない: $claude_account" >&2
    exit 1
fi
if [ ! -d "$codex_account" ]; then
    echo "run-takt: Codex の設定ディレクトリがない: $codex_account" >&2
    exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(pwd -P)
TAKT_CLAUDE_CLI_PATH=$script_dir/takt-claude.sh
TAKT_CLAUDE_ACCOUNT_DIR=$(CDPATH= cd -- "$claude_account" && pwd)
TAKT_CODEX_CLI_PATH=$script_dir/takt-codex.sh
TAKT_CODEX_ACCOUNT_DIR=$(CDPATH= cd -- "$codex_account" && pwd)
TAKT_CONFIG_DIR=$project_dir/.takt/home
CODEX_HOME=$TAKT_CODEX_ACCOUNT_DIR
unset OPENAI_API_KEY CODEX_API_KEY TAKT_OPENAI_API_KEY
export TAKT_CLAUDE_CLI_PATH TAKT_CLAUDE_ACCOUNT_DIR TAKT_CODEX_CLI_PATH TAKT_CODEX_ACCOUNT_DIR TAKT_CONFIG_DIR CODEX_HOME

echo "run-takt: claude のアカウント設定: $TAKT_CLAUDE_ACCOUNT_DIR" >&2
echo "run-takt: Codex の設定: $TAKT_CODEX_ACCOUNT_DIR" >&2
echo "run-takt: TAKT_CONFIG_DIR: $TAKT_CONFIG_DIR" >&2
# takt は、mise があれば mise exec で起動する。プロジェクトの mise.toml で固定した版を、mise が
# 有効でないシェルや IDE から呼ばれても使うため。TAKT_REAL_CLI はテストのための差し替え。
if [ -n "${TAKT_REAL_CLI:-}" ]; then
    exec "$TAKT_REAL_CLI" "$@"
elif command -v mise >/dev/null 2>&1; then
    exec mise exec -- takt "$@"
fi
exec takt "$@"
