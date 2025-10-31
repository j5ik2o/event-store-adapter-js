#!/bin/bash

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
echo $REPO_ROOT
export CODEX_HOME=${REPO_ROOT}/.codex
codex --dangerously-bypass-approvals-and-sandbox
