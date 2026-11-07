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
DB_USER="${POSTGRES_USER:-n8n}"
DB_NAME="${POSTGRES_DB:-n8n}"
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

if [ -f "$TMP_DIR/normalized.json" ]; then
  timezone="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1], encoding='utf-8')).get('timezone','UTC'))" "$TMP_DIR/normalized.json")"
  ok "Client timezone: ${timezone}"
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

if docker compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  schema_ok="$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -Atc "select (to_regclass('app.lead_operations') is not null)::text" 2>/dev/null | tr -d '\r' || true)"
  reserve_ok="$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -Atc "select (to_regprocedure('app.reserve_lead_operation(text,text,text,text,jsonb,boolean,integer,integer,uuid)') is not null)::text" 2>/dev/null | tr -d '\r' || true)"
  save_ok="$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -Atc "select (to_regprocedure('app.save_operation_state(uuid,jsonb)') is not null)::text" 2>/dev/null | tr -d '\r' || true)"
  if [ "$schema_ok" = "true" ] && [ "$reserve_ok" = "true" ] && [ "$save_ok" = "true" ]; then
    ok "PostgreSQL app schema and operation functions are installed"
  else
    fail "PostgreSQL app schema/functions are missing or outdated; run ./scripts/migrate.sh"
  fi
  if [ "$schema_ok" = "true" ]; then
    counts="$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -Atc "select coalesce(status,'unknown') || '=' || count(*) from app.lead_operations group by status order by status" 2>/dev/null | tr '\r' ' ' || true)"
    info "Lead operations: ${counts:-none}"
    overdue="$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -Atc "select count(*) from app.lead_operations where (status='retry_scheduled' and next_attempt_at <= now()) or (status='processing' and updated_at < now() - interval '5 minutes')" 2>/dev/null | tr -d '\r' || true)"
    needs="$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -Atc "select count(*) from app.lead_operations where status='needs_reconciliation'" 2>/dev/null | tr -d '\r' || true)"
    needs_ids="$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -Atc "select coalesce(string_agg(id::text, ', '), '') from app.lead_operations where status='needs_reconciliation'" 2>/dev/null | tr -d '\r' || true)"
    if [ "${overdue:-0}" != "0" ]; then
      warn "${overdue} operation(s) are due for recovery; check Schedule Trigger executions"
    fi
    if [ "${needs:-0}" != "0" ]; then
      warn "${needs} operation(s) require reconciliation: ${needs_ids:-inspect Operations}"
    fi
  else
    warn "Operation status counts unavailable until migrations are applied"
  fi
else
  fail "PostgreSQL is not running; operation state cannot be checked"
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
for node_name in (
    "Reserve Operation",
    "Save CRM State",
    "Save CRM Failure State",
    "Save Journal State",
    "Save Journal Failure State",
    "Save Notification State",
    "Save Final State",
    "Select Due Operations",
):
    if not has_credential(node_name, ["postgres"]):
        failures.append(f"{node_name} has no PostgreSQL credential")
if not has_credential("Recovery Request", ["httpHeaderAuth"]):
    failures.append("Recovery Request has no Header Auth credential")
for required_node in ("Build Operation", "Save Notification State", "Select Due Operations", "Recovery Request", "Schedule Trigger"):
    if required_node not in nodes:
        failures.append(f"required v0.3 node not found: {required_node}")

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

run_integration_readback() {
  local email="$1"
  local generated="$TMP_DIR/readback.json"
  local readback_id exec_id status error_json

  if ! python3 scripts/build-readback-workflow.py \
    "$TMP_DIR/integration.json" "$TMP_DIR/normalized.json" "$TMP_DIR/workflow.json" \
    "$generated" "$email" > "$TMP_DIR/readback-id.txt" 2> "$TMP_DIR/readback-build.err"; then
    fail "Could not build independent read-back workflow: $(cat "$TMP_DIR/readback-build.err")"
    return 1
  fi
  readback_id="$(tr -d '\r\n' < "$TMP_DIR/readback-id.txt")"

  docker compose cp "$generated" n8n:/tmp/doctor-readback.json >/dev/null
  if ! docker compose exec -T n8n n8n import:workflow --input=/tmp/doctor-readback.json >/dev/null 2>&1; then
    fail "Could not import independent read-back workflow"
    return 1
  fi
  docker compose exec -T -e N8N_RUNNERS_BROKER_PORT=5680 n8n n8n execute --id="$readback_id" --rawOutput >/dev/null 2>&1 || true
  exec_id="$(docker compose exec -T postgres psql -U "${POSTGRES_USER:-n8n}" -d "${POSTGRES_DB:-n8n}" -Atc "select id from execution_entity where \"workflowId\"='${readback_id}' order by id desc limit 1" | tr -d '\r')"
  status="$(docker compose exec -T postgres psql -U "${POSTGRES_USER:-n8n}" -d "${POSTGRES_DB:-n8n}" -Atc "select status from execution_entity where id=${exec_id:-0}" | tr -d '\r')"
  if [ "$status" = "success" ]; then
    ok "Independent API read-back verified selected CRM/Journal/Leads targets"
  else
    error_json="$(docker compose exec -T postgres psql -U "${POSTGRES_USER:-n8n}" -d "${POSTGRES_DB:-n8n}" -Atc "select data from execution_data where \"executionId\"=${exec_id:-0}" 2>/dev/null | docker compose exec -T n8n node /home/node/scripts/read-execution.mjs 2>/dev/null || true)"
    fail "Independent API read-back failed (execution ${exec_id:-unknown}): ${error_json:-inspect n8n Executions}"
  fi
  docker compose exec -T n8n rm -f /tmp/doctor-readback.json >/dev/null 2>&1 || true
  docker compose exec -T postgres psql -U "${POSTGRES_USER:-n8n}" -d "${POSTGRES_DB:-n8n}" -c "delete from workflow_entity where id='${readback_id}';" >/dev/null 2>&1 || true
}

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
        run_integration_readback "doctor@example.com"
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
