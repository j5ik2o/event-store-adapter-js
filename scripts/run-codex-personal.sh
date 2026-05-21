#!/usr/bin/env bash

export CODEX_HOME="${HOME}/.codex-personal"

exec mise exec -- codex --dangerously-bypass-approvals-and-sandbox "$@"
