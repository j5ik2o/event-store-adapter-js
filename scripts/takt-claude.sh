#!/bin/sh
# TAKT が claude を起動するときの入口 (TAKT_CLAUDE_CLI_PATH に絶対パスで指定する)。
# TAKT_CLAUDE_ACCOUNT_DIR のアカウント設定 (CLAUDE_CONFIG_DIR) で claude を起動する。
# 指定がない、またはディレクトリがないときは、既定のアカウントに黙って戻さず失敗する。
# 通常は scripts/run-takt.sh から使う。
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
# 動くことを確かめた)。
unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
# 名前付きプロファイルとフェデレーションの認証も、設定ディレクトリのログインより優先される。
unset ANTHROPIC_PROFILE ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID ANTHROPIC_WORKSPACE_ID
# 外部プロバイダーへの切り替えが残ると、認証が設定ディレクトリのアカウントから外れる。
unset CLAUDE_CODE_USE_ANTHROPIC_AWS CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_FOUNDRY \
    CLAUDE_CODE_USE_MANTLE CLAUDE_CODE_USE_VERTEX
# 呼び出し元の接続先・ヘッダー・モデルの指定も外す。外部プロバイダー用のモデル ID が
# 残ると起動後の要求が失敗する。TAKT が引数で渡す --model は、そのまま受け取る。
unset ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_MODEL ANTHROPIC_DEFAULT_MODEL \
    ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL \
    ANTHROPIC_DEFAULT_FABLE_MODEL ANTHROPIC_SMALL_FAST_MODEL
CLAUDE_CONFIG_DIR=$account_dir
export CLAUDE_CONFIG_DIR
# TAKT が起動したエージェントであることの印。フックなどで対話のセッションと見分けるために付ける。
# .takt/ の部品を読ませない設定は、takt-workflows のインストーラーが .claude/settings.json に入れる
TAKT_AGENT=1
export TAKT_AGENT
exec "${TAKT_CLAUDE_REAL_CLI:-claude}" "$@"
