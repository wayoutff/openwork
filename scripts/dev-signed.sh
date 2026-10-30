#!/usr/bin/env bash
set -eo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  source "$NVM_DIR/nvm.sh"
  nvm use --silent "$(<"$ROOT/.nvmrc")"
fi
export PATH="$ROOT/.data/tools/bun-darwin-aarch64:$PATH"
for tool in node corepack bun; do
  if ! command -v "$tool" >/dev/null; then
    printf 'Missing %s. See docs/local-development.md.\n' "$tool" >&2
    exit 1
  fi
done
HOST="$ROOT/.data/computer-use-dev/OpenWork Local.app"
HELPER="$HOST/Contents/Helpers/OpenWork Computer Use.app"
node "$ROOT/scripts/computer-use-preflight.mjs" --host "$HOST" --helper "$HELPER"

# Use only the isolated signed Electron copy; never re-sign node_modules.
export ELECTRON_OVERRIDE_DIST_PATH="$ROOT/.data/computer-use-dev/electron-dist"
export OPENWORK_COMPUTER_USE_BINARY="$HELPER/Contents/MacOS/ComputerUse"
export OPENWORK_ELECTRON_APP_IDENTIFIER=dev.openwork.local
export OPENWORK_LOCAL_COMPUTER_USE=1
export OPENWORK_ELECTRON_APP_NAME="OpenWork Local"
export OPENWORK_ELECTRON_USERDATA="$HOME/Library/Application Support/dev.openwork.local"
export OPENWORK_DEV_MODE=1 OPENWORK_DEV_SHARED_STATE=0
export OPENWORK_DEV_PROFILE=local-signed
export OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN=1
export OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=0
export PORT="${OPENWORK_SIGNED_DEV_PORT:-15374}"
exec corepack pnpm --dir "$ROOT" --filter @openwork/desktop run dev
