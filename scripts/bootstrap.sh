#!/usr/bin/env bash
# Prepare the Python half of the workbench: a re-signed interpreter plus the
# PDF / OCR wheels. Idempotent — run it after every fresh clone or upgrade.
#
#   bash scripts/bootstrap.sh
#
# Environment overrides: PDFW_RUNTIME_DIR, PDFW_PYTHON_ROOT, PDFW_PIP_INDEX.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

TARGET="$(runtime_target)"
PIP_INDEX="${PDFW_PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

step "Locating the DSH runtime Python"
PYROOT="$(python_root)" || {
  echo "error: no DSH runtime Python found under ${DSH_HOME:-$HOME/.dsh}/dsh-runtimes" >&2
  echo "hint : set PDFW_PYTHON_ROOT to a directory containing bin/python3.12" >&2
  exit 1
}
say "python root : $PYROOT"
say "target      : $TARGET"

step "Copying and re-signing the interpreter"
mkdir -p "$TARGET/python/bin" "$TARGET/python/lib" "$TARGET/pylib"
cp "$PYROOT/bin/python3.12" "$TARGET/python/bin/python3.12"
cp "$PYROOT/lib/libpython3.12.dylib" "$TARGET/python/lib/libpython3.12.dylib"
chmod u+w "$TARGET/python/bin/python3.12" "$TARGET/python/lib/libpython3.12.dylib"
if command -v codesign >/dev/null 2>&1; then
  # The DSH interpreter carries the hardened runtime, whose library validation
  # rejects ad-hoc-signed extensions. Re-signing without it is what makes
  # PyMuPDF / onnxruntime loadable.
  codesign --force --sign - "$TARGET/python/lib/libpython3.12.dylib" >/dev/null 2>&1 || true
  codesign --force --sign - "$TARGET/python/bin/python3.12" >/dev/null 2>&1 || true
  say "re-signed (hardened runtime removed)"
else
  say "codesign unavailable — skipping (not macOS?)"
fi

step "Installing Python packages"
PYTHONHOME="$PYROOT" "$(engine_python)" -m pip install \
  --target "$TARGET/pylib" \
  --upgrade \
  --disable-pip-version-check \
  --no-warn-script-location \
  -i "$PIP_INDEX" \
  -r "$BUNDLE/requirements.txt"

step "Verifying the engine"
RESULT="$(PYTHONHOME="$PYROOT" PDFW_PYLIB="$TARGET/pylib" \
  "$(engine_python)" "$BUNDLE/engine/pdf_engine.py" env "$TARGET/env.json" 2>/dev/null || true)"
printf '%s\n' "$RESULT"
case "$RESULT" in
  *'"ok": true'*) say "OK — PyMuPDF and OCR are ready" ;;
  *) echo "error: engine self-check failed; see the output above" >&2; exit 1 ;;
esac

step "Next"
if git -C "$BUNDLE" rev-parse --show-toplevel >/dev/null 2>&1; then
  say "development checkout — restart DeepSeek Harness so the Host reloads."
else
  say "installed package — restart DeepSeek Harness, then refresh the page."
fi
