#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if { ! command -v node >/dev/null || [[ $(node -p 'Number(process.versions.node.split(".")[0])') -lt 24 ]]; } && [[ -x .tools/bin/node ]]; then
  export PATH="$PWD/.tools/bin:$PATH"
fi
if ! command -v node >/dev/null || [[ $(node -p 'Number(process.versions.node.split(".")[0])') -lt 24 ]]; then
  echo 'Node 24 is required. Install it or run scripts/install-dev-tools.sh.' >&2
  exit 1
fi
# npm ci consumes the committed lockfile; --offline is supported for cached installs.
npm ci "$@"
