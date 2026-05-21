#!/usr/bin/env bash

export CODEX_HOME="${HOME}/.codex-personal"

ensure_local_codex_config() {
  local config_path="${CODEX_HOME}/config.toml"
  local base_config="${HOME}/.codex/config.toml"
  local project_header="[projects.\"${HOME}\"]"

  mkdir -p "${CODEX_HOME}"
  if [[ -L "${config_path}" ]]; then
    rm "${config_path}"
  fi
  if [[ ! -f "${config_path}" ]]; then
    cp "${base_config}" "${config_path}"
  fi
  if ! grep -Fq "${project_header}" "${config_path}"; then
    {
      echo ""
      echo "${project_header}"
      echo 'trust_level = "trusted"'
    } >> "${config_path}"
  fi
}

ensure_local_codex_config

exec "/Applications/Codex.app/Contents/MacOS/Codex" "$@"
