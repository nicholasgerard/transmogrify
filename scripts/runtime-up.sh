#!/usr/bin/env bash
# Ensure the installer-managed Codex daemon and its loopback relay, or fall
# back to the detached standalone app-server when the daemon is unavailable.
#
# The daemon hosts every lane's executing turns and survives operator shells.
# Codex Desktop reaches its unix socket through the owned loopback relay.
#
# Env overrides:
#   TRANSMOGRIFY_BIN   codex binary   (default PATH, then standalone fallback)
#   TRANSMOGRIFY_URL   fallback URL   (default ws://127.0.0.1:<port>)
#   TRANSMOGRIFY_PORT  fallback port  (default 8843; ignored when URL is supplied)
#   TRANSMOGRIFY_RELAY_PORT relay port (default 8844)
#   TRANSMOGRIFY_LOG   log file       (default ~/.codex/log/app-server-<port>.log)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROBE="$SCRIPT_DIR/runtime-probe.js"
LAUNCHER="$SCRIPT_DIR/runtime-launch.js"

usage() {
  code="${1:-2}"
  if [ "$code" -eq 0 ]; then
    echo "usage: runtime-up.sh [--url ws://127.0.0.1:<port>]"
    echo "environment: TRANSMOGRIFY_BIN, TRANSMOGRIFY_URL, TRANSMOGRIFY_PORT, TRANSMOGRIFY_RELAY_PORT, TRANSMOGRIFY_LOG"
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
      [ "$#" -ge 2 ] && [ -n "$2" ] || usage
      [ -z "$URL_FLAG" ] || usage
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
  echo "lsof is required to verify the shared runtime port; refusing to launch" >&2
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

ARGS=("$LAUNCHER" --managed --url "$URL" --probe "$PROBE" --relay-port "${TRANSMOGRIFY_RELAY_PORT:-8844}")
if [ -n "$BIN" ]; then
  ARGS+=(--bin "$BIN")
fi
if [ -n "${TRANSMOGRIFY_LOG:-}" ]; then
  ARGS+=(--log "$TRANSMOGRIFY_LOG")
fi

exec node "${ARGS[@]}"
