#!/usr/bin/env bash
# Launch the shared Codex app-server runtime DETACHED from this shell/session,
# or report the one already listening. Safe to run repeatedly.
#
# The runtime hosts every lane's executing turns for this protocol surface. It
# is a standalone app-server: Codex Desktop is not documented to adopt it. Its
# lifetime must be independent of any one operator shell.
#
# Env overrides:
#   TRANSMOGRIFY_BIN   codex binary   (default PATH, then standalone fallback)
#   TRANSMOGRIFY_URL   listen URL     (default ws://127.0.0.1:<port>)
#   TRANSMOGRIFY_PORT  listen port    (default 8843; ignored when URL is supplied)
#   TRANSMOGRIFY_LOG   log file       (default ~/.codex/log/app-server-<port>.log)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROBE="$SCRIPT_DIR/runtime-probe.js"
LAUNCHER="$SCRIPT_DIR/runtime-launch.js"

usage() {
  code="${1:-2}"
  if [ "$code" -eq 0 ]; then
    echo "usage: runtime-up.sh [--url ws://127.0.0.1:<port>]"
    echo "environment: TRANSMOGRIFY_BIN, TRANSMOGRIFY_URL, TRANSMOGRIFY_PORT, TRANSMOGRIFY_LOG"
  else
    echo "usage: runtime-up.sh [--url ws://127.0.0.1:<port>]" >&2
  fi
  exit "$code"
}

if [ "$#" -eq 1 ] && { [ "$1" = "--help" ] || [ "$1" = "-h" ]; }; then
  usage 0
fi

URL_FLAG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url)
      [ "$#" -ge 2 ] || usage
      URL_FLAG="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

if [ -n "$URL_FLAG" ]; then
  URL="$URL_FLAG"
elif [ -n "${TRANSMOGRIFY_URL:-}" ]; then
  URL="$TRANSMOGRIFY_URL"
else
  URL="ws://127.0.0.1:${TRANSMOGRIFY_PORT:-8843}"
fi

command -v lsof >/dev/null 2>&1 || {
  echo "lsof is required to verify the shared runtime port; refusing to launch"
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "node is required to verify the app-server protocol handshake" >&2
  exit 1
}
[ -f "$PROBE" ] || {
  echo "runtime probe is missing: $PROBE" >&2
  exit 1
}
[ -f "$LAUNCHER" ] || {
  echo "runtime launcher is missing: $LAUNCHER" >&2
  exit 1
}

BIN="${TRANSMOGRIFY_BIN:-}"
if [ -z "$BIN" ] && command -v codex >/dev/null 2>&1; then
  BIN="$(command -v codex)"
fi
if [ -z "$BIN" ] && [ -n "${HOME:-}" ]; then
  BIN="$HOME/.codex/packages/standalone/current/codex"
fi

ARGS=("$LAUNCHER" --url "$URL" --probe "$PROBE")
if [ -n "$BIN" ]; then
  ARGS+=(--bin "$BIN")
fi
if [ -n "${TRANSMOGRIFY_LOG:-}" ]; then
  ARGS+=(--log "$TRANSMOGRIFY_LOG")
fi

exec node "${ARGS[@]}"
