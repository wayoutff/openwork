#!/usr/bin/env bash
set -eo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  source "$NVM_DIR/nvm.sh"
  nvm use --silent "$(<"$ROOT/.nvmrc")"
fi
case "${1:-start}" in
  start) exec node "$ROOT/scripts/den-local-stack.mjs" ;;
  status) exec node "$ROOT/scripts/den-local.mjs" status ;;
  *) printf '%s\n' 'Usage: bash scripts/den-local.sh [start|status]' >&2; exit 1 ;;
esac
