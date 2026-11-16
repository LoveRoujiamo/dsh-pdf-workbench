#!/usr/bin/env bash
# Shared helpers for the maintainer scripts. Source, do not execute.

set -euo pipefail

# Repository / package root (the directory holding package.json).
BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_VERSION="3.12"

# Where the Python half lives. Mirrors runtimeHome() in index.js:
#   - development checkout  -> <repo>/engine/runtime
#   - installed package     -> $DSH_HOME/pdf-workbench-runtime
# PDFW_RUNTIME_DIR overrides both.
runtime_target() {
  if [[ -n "${PDFW_RUNTIME_DIR:-}" ]]; then
    printf '%s\n' "$PDFW_RUNTIME_DIR"
    return 0
  fi
  if git -C "$BUNDLE" rev-parse --show-toplevel >/dev/null 2>&1; then
    printf '%s\n' "$BUNDLE/engine/runtime"
  else
    printf '%s\n' "${DSH_HOME:-$HOME/.dsh}/pdf-workbench-runtime"
  fi
}

# The DSH-managed CPython that the engine borrows its standard library from.
python_root() {
  local candidates=()
  [[ -n "${PDFW_PYTHON_ROOT:-}" ]] && candidates+=("$PDFW_PYTHON_ROOT")
  local home="${DSH_HOME:-$HOME/.dsh}"
  local dir
  for dir in "$home"/dsh-runtimes/*/dependencies/python; do
    [[ -d "$dir" ]] && candidates+=("$dir")
  done
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate/bin/python$PYTHON_VERSION" && -d "$candidate/lib/python$PYTHON_VERSION" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

engine_python() {
  printf '%s\n' "$(runtime_target)/python/bin/python$PYTHON_VERSION"
}
