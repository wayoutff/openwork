#!/usr/bin/env bash
set -eo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  source "$NVM_DIR/nvm.sh"
  nvm use --silent "$(<"$ROOT/.nvmrc")"
fi

if ! command -v node >/dev/null || ! command -v corepack >/dev/null; then
  printf '%s\n' 'Install the Node version in .nvmrc with Corepack first.' >&2
  exit 1
fi
if [[ "$(node --version)" != "v$(<"$ROOT/.nvmrc")" ]]; then
  printf '%s\n' 'Wrong Node version. Run nvm install from the repository root.' >&2
  exit 1
fi
if [[ ! -d "$ROOT/node_modules" ]]; then
  printf 'Install dependencies first: corepack pnpm --dir "%s" install --frozen-lockfile\n' "$ROOT" >&2
  exit 1
fi

if [[ -x "$ROOT/.data/tools/bun-darwin-aarch64/bun" ]]; then
  export PATH="$ROOT/.data/tools/bun-darwin-aarch64:$PATH"
fi
if ! command -v bun >/dev/null; then
  printf '%s\n' 'Bun is required to bundle server plugins. See docs/local-development.md.' >&2
  exit 1
fi

# Keep the renderer origin stable so preferences survive subsequent launches.
export OPENWORK_DEV_MODE=1 OPENWORK_DEV_PROFILE=auto
export OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN="${OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN:-1}"
export OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=0
export PORT="${OPENWORK_LOCAL_DEV_PORT:-15373}"
export OPENWORK_DEV_SHARED_STATE=0
unset OPENWORK_ELECTRON_APP_IDENTIFIER OPENWORK_ELECTRON_USERDATA
exec corepack pnpm --dir "$ROOT" --filter @openwork/desktop run dev
