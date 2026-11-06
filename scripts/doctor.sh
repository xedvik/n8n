#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

BASE_URL="${BASE_URL:-http://127.0.0.1:5678}"
WORKFLOW_ID="${WORKFLOW_ID:-7c9f5a2e-3b4d-4f6a-9c1e-2d8b7a6f5e40}"
CONFIG_FILE="${LEAD_CONFIG_FILE:-./config/client.json}"
CONFIG_FILE="${CONFIG_FILE#./}"
WEBHOOK_HEADER_NAME="${LEAD_WEBHOOK_HEADER_NAME:-X-Webhook-Secret}"
WEBHOOK_SECRET="${LEAD_WEBHOOK_SECRET:-}"
INTEGRATION_TEST=0
for arg in "$@"; do
  case "$arg" in
    --integration-test) INTEGRATION_TEST=1 ;;
    --help|-h)
      echo "Usage: ./scripts/doctor.sh [--integration-test]"
      echo "Without --integration-test, no real CRM/journal/notification writes are made."
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
FAILED=0

fail() { echo "FAIL: $*" >&2; FAILED=1; }
ok() { echo "OK:   $*"; }
warn() { echo "WARN: $*"; }
info() { echo "INFO: $*"; }

echo "CRM Automation Kit doctor"
echo "Config: $CONFIG_FILE"
echo

if docker compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  ok "PostgreSQL container is running"
else
  fail "PostgreSQL container is not running (docker compose up -d)"
fi
if docker compose ps --status running --services 2>/dev/null | grep -qx n8n; then
  ok "n8n container is running"
else
  fail "n8n container is not running (docker compose up -d)"
fi

if curl -fsS "${BASE_URL}/healthz/readiness" >/dev/null 2>&1; then
  ok "n8n readiness endpoint responds"
else
  fail "n8n readiness endpoint is unavailable at ${BASE_URL}/healthz/readiness"
fi

[ -f "$CONFIG_FILE" ] || fail "Client config not found: $CONFIG_FILE"

if [ -f "$CONFIG_FILE" ]; then
  if command -v node >/dev/null 2>&1; then
    if ! node scripts/config-check.mjs "$CONFIG_FILE" > "$TMP_DIR/normalized.json" 2>"$TMP_DIR/config.err"; then
      fail "Client config is invalid: $(cat "$TMP_DIR/config.err")"
    fi
  elif docker compose ps --status running --services 2>/dev/null | grep -qx n8n; then
    docker compose cp "$CONFIG_FILE" n8n:/tmp/doctor-config.json >/dev/null
    if ! docker compose exec -T n8n node /home/node/scripts/config-check.mjs /tmp/doctor-config.json > "$TMP_DIR/normalized.json" 2>"$TMP_DIR/config.err"; then
      fail "Client config is invalid: $(cat "$TMP_DIR/config.err")"
    fi
    docker compose exec -T n8n rm -f /tmp/doctor-config.json >/dev/null 2>&1 || true
  else
    fail "Cannot validate config: install Node.js or start the n8n container"
  fi
fi

if [ -f "$CONFIG_FILE" ]; then
  host_hash="$(sha256sum "$CONFIG_FILE" | awk '{print $1}')"
  container_hash="$(docker compose exec -T n8n sha256sum /home/node/config/client.json 2>/dev/null | awk '{print $1}' || true)"
  if [ -n "$container_hash" ] && [ "$host_hash" != "$container_hash" ]; then
    fail "The running n8n container uses a different config. Run: docker compose up -d"
  elif [ -n "$container_hash" ]; then
    ok "Running n8n uses the checked config file"
  fi
fi

if docker compose exec -T n8n n8n list:workflow --active=true 2>/dev/null | grep -q "${WORKFLOW_ID}"; then
  ok "Workflow ${WORKFLOW_ID} is active"
else
  fail "Workflow ${WORKFLOW_ID} is not active (publish/activate it in n8n)"
fi

if docker compose exec -T n8n n8n export:workflow --id="${WORKFLOW_ID}" --output=/tmp/doctor-workflow.json >/dev/null 2>&1 \
  && docker compose cp n8n:/tmp/doctor-workflow.json "$TMP_DIR/workflow.json" >/dev/null 2>&1; then
  docker compose exec -T n8n rm -f /tmp/doctor-workflow.json >/dev/null 2>&1 || true
  if [ -f "$TMP_DIR/normalized.json" ]; then
    if ! python3 - "$TMP_DIR/normalized.json" "$TMP_DIR/workflow.json" "$INTEGRATION_TEST" <<'PY'
import json
import sys

config = json.load(open(sys.argv[1], encoding="utf-8"))
workflow = json.load(open(sys.argv[2], encoding="utf-8"))
if isinstance(workflow, list):
    workflow = workflow[0]
integration_test = sys.argv[3] == "1"
nodes = {node["name"]: node for node in workflow.get("nodes", [])}
failures = []
warnings = []

def has_credential(node_name, keys):
    node = nodes.get(node_name)
    if not node:
        failures.append(f"node not found: {node_name}")
        return False
    credentials = node.get("credentials") or {}
    return any(key in credentials for key in keys)

def non_placeholder(value, name):
    if not value or str(value).startswith("REPLACE_WITH_"):
        failures.append(f"{name} is empty or still a placeholder")

if not has_credential("Lead Webhook", ["httpHeaderAuth"]):
    failures.append("Lead Webhook has no Header Auth credential")

provider = config.get("crm", {}).get("provider")
if provider == "google_sheets":
    if not has_credential("CRM Adapter - Google Sheets", ["googleSheetsOAuth2Api", "googleApi"]):
        failures.append("CRM Adapter - Google Sheets has no Google credential")
    non_placeholder(config["crm"]["googleSheets"].get("spreadsheetId"), "crm.googleSheets.spreadsheetId")
elif provider == "hubspot":
    for name in ("HubSpot Search Contact", "HubSpot Create Contact", "HubSpot Update Contact"):
        if not has_credential(name, ["hubspotAppToken", "hubspotOAuth2Api"]):
            failures.append(f"{name} has no HubSpot Service Key/OAuth2 credential")
    if not integration_test:
        warnings.append("HubSpot credential check only; real HubSpot API was not called (use --integration-test)")
elif provider == "none":
    warnings.append("CRM provider is none; leads rely on the journal")

if config.get("journal", {}).get("enabled"):
    if not has_credential("Journal Adapter - Google Sheets", ["googleSheetsOAuth2Api", "googleApi"]):
        failures.append("Journal Adapter - Google Sheets has no Google credential")
    non_placeholder(config["journal"]["googleSheets"].get("spreadsheetId"), "journal.googleSheets.spreadsheetId")

if config.get("errors", {}).get("enabled"):
    if not has_credential("Error Log Adapter - Google Sheets", ["googleSheetsOAuth2Api", "googleApi"]):
        failures.append("Error Log Adapter - Google Sheets has no Google credential")
    non_placeholder(config["errors"]["googleSheets"].get("spreadsheetId"), "errors.googleSheets.spreadsheetId")

if config.get("notifications", {}).get("enabled"):
    if "telegram" in config["notifications"].get("channels", []):
        if not has_credential("Notification Adapter - Telegram", ["telegramApi"]):
            failures.append("Notification Adapter - Telegram has no Telegram credential")
        non_placeholder(config["notifications"]["telegram"].get("chatId"), "notifications.telegram.chatId")

for warning in warnings:
    print(f"WARN: {warning}")
for failure in failures:
    print(f"FAIL: {failure}")
if failures:
    sys.exit(1)
print("OK:   Selected integration credentials are assigned")
PY
    then
      FAILED=1
    fi
  fi
else
  fail "Could not export active workflow for credential checks"
fi

if [ -z "$WEBHOOK_SECRET" ]; then
  fail "LEAD_WEBHOOK_SECRET is not set in .env; cannot test Header Auth"
else
  noauth="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/webhook/lead-intake" -H 'Content-Type: application/json' --data @examples/invalid-lead.json || true)"
  case "$noauth" in
    401|403) ok "Webhook rejects requests without Header Auth (HTTP ${noauth})" ;;
    404) fail "Webhook is not registered (HTTP 404); workflow is not active" ;;
    *) fail "Webhook without Header Auth returned HTTP ${noauth}, expected 401/403" ;;
  esac
  wrongauth="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/webhook/lead-intake" -H 'Content-Type: application/json' -H "${WEBHOOK_HEADER_NAME}: wrong-secret" --data @examples/invalid-lead.json || true)"
  case "$wrongauth" in
    401|403) ok "Webhook rejects wrong Header Auth (HTTP ${wrongauth})" ;;
    *) fail "Webhook with wrong Header Auth returned HTTP ${wrongauth}, expected 401/403" ;;
  esac
  validauth="$(curl -sS -o "$TMP_DIR/invalid.json" -w '%{http_code}' -X POST "${BASE_URL}/webhook/lead-intake" -H 'Content-Type: application/json' -H "${WEBHOOK_HEADER_NAME}: ${WEBHOOK_SECRET}" --data @examples/invalid-lead.json || true)"
  if [ "$validauth" = "400" ]; then
    ok "Webhook accepts Header Auth and validates the request (HTTP 400 on invalid lead)"
  else
    fail "Webhook with correct Header Auth returned HTTP ${validauth}, expected 400 on invalid lead"
    cat "$TMP_DIR/invalid.json" >&2 || true
  fi
fi

if [ "$INTEGRATION_TEST" = "1" ]; then
  echo
  warn "Integration test will create real CRM/journal data and may send a notification."
  mark="doctor-$(date -u +%Y%m%dT%H%M%SZ)"
  python3 - "$mark" > "$TMP_DIR/integration-payload.json" <<'PY'
import json
import sys
print(json.dumps({
    "name": "Doctor Integration Test",
    "email": "doctor@example.com",
    "phone": "+7 (900) 555-99-99",
    "source": "doctor",
    "message": "Explicit doctor.sh integration test",
    "external_id": sys.argv[1],
}))
PY
  response_status="$(curl -sS -o "$TMP_DIR/integration.json" -w '%{http_code}' \
    -X POST "${BASE_URL}/webhook/lead-intake" \
    -H 'Content-Type: application/json' \
    -H "${WEBHOOK_HEADER_NAME}: ${WEBHOOK_SECRET}" \
    --data-binary "@$TMP_DIR/integration-payload.json" 2>/dev/null || true)"
  case "$response_status" in
    200|201|202)
      if python3 - "$TMP_DIR/integration.json" <<'PY'
import json
import sys
body = json.load(open(sys.argv[1], encoding="utf-8"))
assert body.get("ok") is True, body
crm = body.get("crm", {})
journal = body.get("journal", {})
if crm.get("provider") == "none":
    assert journal.get("enabled") is True and journal.get("status") == "saved", f"Journal-only mode did not persist the lead: {body}"
else:
    assert crm.get("status") in ("created", "updated"), f"CRM did not create/update a record: {crm}"
notifications = body.get("notifications", {})
if notifications.get("enabled"):
    assert body.get("notified") is True, f"Notification was not sent: {notifications}"
if journal.get("enabled"):
    assert journal.get("status") == "saved", f"Journal write failed: {journal}"
print(f"OK:   Integration request accepted: HTTP {body.get('status')}, crm={crm.get('status')}, notified={body.get('notified')}")
PY
      then
        :
      else
        fail "Integration response is not a successful lead-intake response"
      fi
      ;;
    *)
      fail "Integration test returned HTTP ${response_status}"
      cat "$TMP_DIR/integration.json" >&2 || true
      ;;
  esac
else
  info "Integration test not run. Use --integration-test to create one real test lead."
fi

echo
if [ "$FAILED" = "0" ]; then
  echo "RESULT: PASS (no failed mandatory checks)"
  exit 0
fi
echo "RESULT: FAIL"
exit 1
