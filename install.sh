#!/usr/bin/env bash
# Install the Transmogrify skill for Claude Code and Codex hosts.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

command -v node >/dev/null 2>&1 || {
  echo "node 20 or newer is required" >&2
  exit 1
}

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    echo "could not determine Node.js version" >&2
    exit 1
    ;;
esac
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "node 20 or newer is required (found $(node --version))" >&2
  exit 1
fi

node "$HERE/scripts/install.js" "$@"
