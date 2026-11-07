#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
WIZARD_DATA_DIR="$ROOT_DIR/wizard-data"
UNIT_FILE="/etc/systemd/system/crm-wizard.service"
UNIT_NAME="crm-wizard.service"
WORKFLOW_ID="${WORKFLOW_ID:-7c9f5a2e-3b4d-4f6a-9c1e-2d8b7a6f5e40}"

usage() {
  cat >&2 <<'EOF'
Usage: sudo ./scripts/install-server.sh <domain> <email>

Example:
  sudo ./scripts/install-server.sh crm.example.com admin@example.com
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

for cmd in docker openssl curl systemctl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 1
  fi
done
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
  if command -v runuser >/dev/null 2>&1 && ! runuser -u "$RUN_USER" -- docker info >/dev/null 2>&1; then
    echo "WARNING: ${RUN_USER} cannot access Docker; doctor/workflow actions launched from the wizard will fail. Add the user to the docker group or run the installer as root." >&2
  fi
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ "$RUN_USER" != "root" ] && command -v runuser >/dev/null 2>&1; then
  NODE_BIN="$(runuser -u "$RUN_USER" -- bash -lc 'command -v node' 2>/dev/null | tail -n 1 | tr -d '\r' || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "Node.js 22+ is required for the Setup Wizard (node not found)." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "Node.js 22+ is required for the Setup Wizard (found $("$NODE_BIN" --version 2>/dev/null || echo unknown))." >&2
  exit 1
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

set_env N8N_HOST "$DOMAIN"
set_env N8N_PROTOCOL "https"
set_env N8N_WEBHOOK_URL "https://${DOMAIN}/"
set_env N8N_EDITOR_BASE_URL "https://${DOMAIN}/"
set_env N8N_BIND_ADDRESS "127.0.0.1"
set_env CRM_DOMAIN "$DOMAIN"
set_env ACME_EMAIL "$EMAIL"
set_env WIZARD_SERVER_MODE "1"
set_env WIZARD_HOST "127.0.0.1"
set_env WIZARD_PORT "8787"
set_env WIZARD_ALLOWED_HOSTS "$DOMAIN"
set_env WIZARD_COOKIE_SECURE "1"
set_env WIZARD_COOKIE_PATH "/setup"
set_env WIZARD_DATA_DIR "./wizard-data"
N8N_PORT_VALUE="5678"
set_env N8N_PORT "$N8N_PORT_VALUE"
set_env N8N_API_URL "http://127.0.0.1:${N8N_PORT_VALUE}"
set_env N8N_PUBLIC_URL "https://${DOMAIN}/"
set_env LEAD_CONFIG_FILE "./config/client.json"

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
  for port in 80 443 5678 8787; do
    if ss -ltnH "sport = :${port}" 2>/dev/null | grep -q .; then
      echo "WARNING: TCP port ${port} is already in use; the server stack may fail to bind it." >&2
    fi
  done
fi

docker compose -f docker-compose.yml -f docker-compose.server.yml config -q

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=CRM Automation Kit Setup Wizard
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
WorkingDirectory=${ROOT_DIR}
EnvironmentFile=${ENV_FILE}
Environment=PATH=${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${ROOT_DIR}/scripts/start-wizard.sh
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

chmod 644 "$UNIT_FILE"
systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"

docker compose -f docker-compose.yml -f docker-compose.server.yml up -d

N8N_PORT_VALUE="$(get_env N8N_PORT)"
N8N_PORT_VALUE="${N8N_PORT_VALUE:-5678}"
ready=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${N8N_PORT_VALUE}/healthz/readiness" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" != "1" ]; then
  echo "n8n did not become ready at http://127.0.0.1:${N8N_PORT_VALUE}." >&2
  echo "Check: docker compose -f docker-compose.yml -f docker-compose.server.yml logs --tail=100 n8n" >&2
  exit 1
fi

./scripts/migrate.sh

existing_id="$(docker compose -f docker-compose.yml -f docker-compose.server.yml exec -T n8n n8n list:workflow --onlyId 2>/dev/null | tr -d '\r' | grep -Fx "$WORKFLOW_ID" || true)"
if [ -z "$existing_id" ]; then
  ./scripts/import-workflow.sh
else
  echo "Workflow ${WORKFLOW_ID} already exists; skipping import to preserve credentials."
fi

systemctl restart "$UNIT_NAME"

WIZARD_PORT_VALUE="$(get_env WIZARD_PORT)"
WIZARD_PORT_VALUE="${WIZARD_PORT_VALUE:-8787}"
wizard_ready=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${WIZARD_PORT_VALUE}/api/health" >/dev/null 2>&1; then
    wizard_ready=1
    break
  fi
  sleep 1
done
if [ "$wizard_ready" != "1" ]; then
  echo "Wizard did not become ready at http://127.0.0.1:${WIZARD_PORT_VALUE}/api/health." >&2
  systemctl --no-pager status "$UNIT_NAME" >&2 || true
  journalctl -u "$UNIT_NAME" -n 50 --no-pager >&2 || true
  exit 1
fi

cat <<EOF

CRM Automation Kit server is installed.

Next actions:
  1. Open https://${DOMAIN}/ and create the n8n owner account.
  2. Open https://${DOMAIN}/settings/api and create an API key with scopes:
     workflow:read, workflow:update, workflow:activate,
     credential:list, credential:read, credential:create
  3. Open the setup wizard, register the admin account and connect the n8n API key.

EOF

if [ -n "$FIRST_RUN_TOKEN" ]; then
  echo "First-run setup URL: https://${DOMAIN}/setup/?token=${FIRST_RUN_TOKEN}"
else
  echo "Setup URL: https://${DOMAIN}/setup/"
fi
