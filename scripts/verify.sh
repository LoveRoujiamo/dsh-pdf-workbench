#!/usr/bin/env bash
# Run every check for this plugin. Needs a bootstrapped engine (scripts/bootstrap.sh).
#
#   bash scripts/verify.sh          # all suites
#   bash scripts/verify.sh --quick  # syntax + client only (no Python needed)

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"
cd "$BUNDLE"

quick=0
[[ "${1:-}" == "--quick" ]] && quick=1

echo "== syntax"
node --check index.js
node --check catalog.js
node --check client.js
node --check tests/host-smoke.mjs
node --check tests/ai-smoke.mjs

echo "== client self-test"
node client.selftest.mjs

if [[ "$quick" == "1" ]]; then
  echo "== done (quick)"
  exit 0
fi

PYROOT="$(python_root)" || {
  echo "error: run scripts/bootstrap.sh first" >&2
  exit 1
}
export PYTHONHOME="$PYROOT"
export PDFW_PYLIB="$(runtime_target)/pylib"

echo "== engine self-test (46 checks over 23 operations)"
"$(engine_python)" engine/selftest.py

echo "== host integration"
node tests/host-smoke.mjs --engine

echo "== ai pipeline"
node tests/ai-smoke.mjs

echo
echo "all suites passed"
