#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

export WIZARD_HOST="${WIZARD_HOST:-127.0.0.1}"
export WIZARD_PORT="${WIZARD_PORT:-8787}"

if [ -z "${N8N_API_KEY:-}" ] && [ -t 0 ] && [ "${WIZARD_NO_PROMPT:-0}" != "1" ]; then
  printf 'n8n API key (Enter — пропустить автоматизацию credentials): ' >&2
  IFS= read -r -s N8N_API_KEY || true
  printf '\n' >&2
  export N8N_API_KEY
fi

printf 'CRM Setup Wizard: http://%s:%s\n' "$WIZARD_HOST" "$WIZARD_PORT" >&2
printf 'API key n8n: %s\n' "${N8N_API_KEY:+задан}" >&2
if [ -z "${N8N_API_KEY:-}" ]; then
  printf 'Без API key мастер сохранит конфиг, но credentials нужно назначить в n8n вручную.\n' >&2
  printf 'Создать ключ: http://127.0.0.1:5678/settings/api\n' >&2
fi

exec node wizard/server.mjs
