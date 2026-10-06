#!/bin/sh
# TAKT が claude を起動するときの入口 (TAKT_CLAUDE_CLI_PATH に絶対パスで指定する)。
# TAKT_CLAUDE_ACCOUNT_DIR のアカウント設定 (CLAUDE_CONFIG_DIR) で claude を起動する。
# 指定がない、またはディレクトリがないときは、既定のアカウントに黙って戻さず失敗する。
# 通常は同じディレクトリの run-takt.sh から使う。
set -eu

account_dir=${TAKT_CLAUDE_ACCOUNT_DIR:-}
if [ -z "$account_dir" ]; then
    echo "takt-claude: TAKT_CLAUDE_ACCOUNT_DIR が指定されていない" >&2
    exit 1
fi
if [ ! -d "$account_dir" ]; then
    echo "takt-claude: アカウントの設定ディレクトリがない: $account_dir" >&2
    exit 1
fi

# 認証の情報を持つ環境変数は、CLAUDE_CONFIG_DIR より優先される。呼び出し元のシェルに
# CLAUDE_CODE_OAUTH_TOKEN などが残っていると、設定ディレクトリを替えても同じアカウントで
# 動いてしまうので、外してから起動する (2026-09-24 に、上限に達したアカウントのまま
# 動くことを確かめた)。Bedrock・Vertex を選ぶ変数が残っていても、アカウントではなくそちらで動くので外す。
# 組織・提供元・接続先・モデルの上書きも、選んだアカウントの設定を妨げるので外す。
unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX \
    ANTHROPIC_PROFILE ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID ANTHROPIC_WORKSPACE_ID \
    CLAUDE_CODE_USE_ANTHROPIC_AWS CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_MANTLE \
    ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_MODEL ANTHROPIC_DEFAULT_MODEL \
    ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL \
    ANTHROPIC_DEFAULT_FABLE_MODEL ANTHROPIC_SMALL_FAST_MODEL \
    CLAUDE_CODE_SUBAGENT_MODEL CLAUDE_CODE_SUBAGENT_MODEL_FORCE
CLAUDE_CONFIG_DIR=$account_dir
export CLAUDE_CONFIG_DIR
# TAKT が起動したエージェントであることの印 (takt-codex.sh と同じ)
TAKT_AGENT=1
export TAKT_AGENT
exec "${TAKT_CLAUDE_REAL_CLI:-claude}" "$@"
