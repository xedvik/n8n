#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
WIZARD_DATA_DIR="$ROOT_DIR/wizard-data"
WORKFLOW_ID="${WORKFLOW_ID:-7c9f5a2e-3b4d-4f6a-9c1e-2d8b7a6f5e40}"

usage() {
  cat >&2 <<'EOF'
Usage: sudo ./scripts/install-server.sh <domain> <email>

Example:
  sudo ./scripts/install-server.sh crm.example.com admin@example.com

This is the only supported deployment path. It starts one Docker Compose
stack: Caddy + n8n + PostgreSQL + Setup Wizard.
EOF
}

if [ "$#" -ne 2 ]; then
  usage
  exit 2
fi

DOMAIN="$1"
EMAIL="$2"

if [[ ! "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then
  echo "Invalid domain: $DOMAIN" >&2
  exit 2
fi
if [[ ! "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  echo "Invalid email: $EMAIL" >&2
  exit 2
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "This installer must run as root (use sudo)." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required: https://docs.docker.com/engine/install/" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is required (docker compose)." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not reachable. Start Docker and retry." >&2
  exit 1
fi

RUN_USER="${SUDO_USER:-root}"
if [ "$RUN_USER" = "root" ]; then
  RUN_GROUP="root"
else
  RUN_GROUP="$(id -gn "$RUN_USER")"
fi

get_env() {
  awk -v key="$1" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$ENV_FILE"
}

set_env() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

ensure_secret() {
  local key="$1"
  local current
  current="$(get_env "$key")"
  if [ -z "$current" ] || [[ "$current" == CHANGE_ME* ]]; then
    set_env "$key" "$(openssl rand -hex 32)"
    echo "Generated $key"
  fi
}

if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo "Created $ENV_FILE from .env.example"
fi
chmod 600 "$ENV_FILE"

for key in POSTGRES_PASSWORD N8N_ENCRYPTION_KEY LEAD_WEBHOOK_SECRET WIZARD_SECRET_KEY; do
  ensure_secret "$key"
done

set_env CRM_DOMAIN "$DOMAIN"
set_env ACME_EMAIL "$EMAIL"
set_env N8N_HOST "$DOMAIN"
set_env N8N_PORT "5678"
set_env N8N_PROTOCOL "https"
set_env N8N_WEBHOOK_URL "https://${DOMAIN}/"
set_env N8N_EDITOR_BASE_URL "https://${DOMAIN}/"
set_env N8N_PROXY_HOPS "1"
set_env N8N_API_URL "http://n8n:5678"
set_env N8N_PUBLIC_URL "https://${DOMAIN}/"
set_env BASE_URL "http://n8n:5678"

set_env WIZARD_SERVER_MODE "1"
set_env WIZARD_HOST "0.0.0.0"
set_env WIZARD_PORT "8787"
set_env WIZARD_ALLOW_REMOTE "1"
set_env WIZARD_TRUST_PROXY "1"
set_env WIZARD_ALLOWED_HOSTS "$DOMAIN"
set_env WIZARD_COOKIE_SECURE "1"
set_env WIZARD_COOKIE_PATH "/setup"
set_env WIZARD_DATA_DIR "/data"
set_env WIZARD_CONFIG_FILE "/app/config/client.json"
set_env WIZARD_CONFIG_UID "$(id -u "$RUN_USER")"
set_env WIZARD_CONFIG_GID "$(id -g "$RUN_USER")"
set_env LEAD_CONFIG_FILE "/app/config/client.json"
set_env WORKFLOW_ID "$WORKFLOW_ID"
set_env COMPOSE_PROJECT_NAME "crm-automation-kit"

install -d -m 700 "$WIZARD_DATA_DIR"
install -d -m 700 "$ROOT_DIR/config"

AUTH_FILE="$WIZARD_DATA_DIR/auth.json"
TOKEN_FILE="$WIZARD_DATA_DIR/bootstrap-token"
FIRST_RUN_TOKEN=""
if [ ! -f "$AUTH_FILE" ]; then
  if [ ! -f "$TOKEN_FILE" ]; then
    umask 077
    openssl rand -hex 32 > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
  fi
  FIRST_RUN_TOKEN="$(cat "$TOKEN_FILE")"
fi

if [ "$RUN_USER" = "root" ]; then
  chown -R root:root "$ROOT_DIR/config" "$WIZARD_DATA_DIR" "$ENV_FILE"
else
  chown -R "$RUN_USER:$RUN_GROUP" "$ROOT_DIR/config" "$WIZARD_DATA_DIR" "$ENV_FILE"
fi

if command -v ss >/dev/null 2>&1; then
  for port in 80 443; do
    if ss -ltnH "sport = :${port}" 2>/dev/null | grep -q .; then
      echo "WARNING: TCP port ${port} is already in use; Caddy may fail to bind it." >&2
    fi
  done
fi

docker compose config -q
echo "Building the unified stack..."
docker compose up -d --build

wait_for() {
  local label="$1"
  shift
  local ready=0
  for _ in $(seq 1 90); do
    if "$@" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 2
  done
  if [ "$ready" != "1" ]; then
    echo "${label} did not become ready." >&2
    docker compose ps >&2 || true
    docker compose logs --tail=100 n8n wizard >&2 || true
    exit 1
  fi
}

wait_for "n8n" docker compose exec -T n8n wget -q -O /dev/null http://127.0.0.1:5678/healthz/readiness
wait_for "Setup Wizard" docker compose exec -T wizard node -e "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

./scripts/migrate.sh

existing_id="$(docker compose exec -T n8n n8n list:workflow --onlyId 2>/dev/null | tr -d '\r' | grep -Fx "$WORKFLOW_ID" || true)"
if [ -z "$existing_id" ]; then
  echo "Importing the CRM workflow through the setup container..."
  docker compose exec -T wizard bash -lc 'cd /app && BASE_URL=http://n8n:5678 ./scripts/import-workflow.sh'
else
  echo "Workflow ${WORKFLOW_ID} already exists; preserving it and its credentials."
fi

# The wizard owns the full post-deploy onboarding. No operator CLI step is
# required after this point.
cat <<EOF

CRM Automation Kit is installed as one Docker Compose stack.

Containers:
  - caddy      : public HTTPS on ports 80/443, routes / and /setup/
  - n8n        : internal only (no host port)
  - postgres   : internal only (no host port)
  - wizard     : internal only, exposed through /setup/

Next actions:
  1. Open https://${DOMAIN}/ and create the n8n owner account.
  2. Open https://${DOMAIN}/settings/api and create an API key with scopes:
     workflow:read, workflow:update, workflow:activate,
     credential:list, credential:read, credential:create
  3. Complete the entire project setup in the browser:
     https://${DOMAIN}/setup/

The wizard will guide you through the app address, n8n connection, CRM,
Google Sheets/Telegram credentials, table creation, mapping, retry policy,
integration checks and the confirmed test lead.

EOF

if [ -n "$FIRST_RUN_TOKEN" ]; then
  echo "First-run setup URL: https://${DOMAIN}/setup/?token=${FIRST_RUN_TOKEN}"
else
  echo "Setup URL: https://${DOMAIN}/setup/"
fi
