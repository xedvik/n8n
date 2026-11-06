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
WEBHOOK_PATH="${WEBHOOK_PATH:-lead-intake}"
WEBHOOK_HEADER_NAME="${LEAD_WEBHOOK_HEADER_NAME:-X-Webhook-Secret}"
WEBHOOK_SECRET="${LEAD_WEBHOOK_SECRET:-}"
VALID_LEAD_FILE="${VALID_LEAD_FILE:-examples/valid-lead.json}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -n "$WEBHOOK_SECRET" ] || fail "LEAD_WEBHOOK_SECRET is not set. Add it to .env and use the same value in the n8n Header Auth credential."

post() {
  local payload="$1"
  local output="$2"
  curl -sS -o "$output" -w '%{http_code}' \
    -X POST "${BASE_URL}/webhook/${WEBHOOK_PATH}" \
    -H 'Content-Type: application/json' \
    -H "${WEBHOOK_HEADER_NAME}: ${WEBHOOK_SECRET}" \
    --data-binary "@${payload}"
}

post_without_auth() {
  local payload="$1"
  local output="$2"
  curl -sS -o "$output" -w '%{http_code}' \
    -X POST "${BASE_URL}/webhook/${WEBHOOK_PATH}" \
    -H 'Content-Type: application/json' \
    --data-binary "@${payload}"
}

post_with_wrong_auth() {
  local payload="$1"
  local output="$2"
  curl -sS -o "$output" -w '%{http_code}' \
    -X POST "${BASE_URL}/webhook/${WEBHOOK_PATH}" \
    -H 'Content-Type: application/json' \
    -H "${WEBHOOK_HEADER_NAME}: wrong-secret" \
    --data-binary "@${payload}"
}

noauth_status="$(post_without_auth examples/invalid-lead.json "$TMP_DIR/noauth.json")"
case "$noauth_status" in
  401|403) ;;
  *) fail "request without auth returned HTTP ${noauth_status}, expected 401/403" ;;
esac

wrongauth_status="$(post_with_wrong_auth examples/invalid-lead.json "$TMP_DIR/wrongauth.json")"
case "$wrongauth_status" in
  401|403) ;;
  *) fail "request with wrong auth returned HTTP ${wrongauth_status}, expected 401/403" ;;
esac

invalid_status=""
for _ in $(seq 1 20); do
  invalid_status="$(post examples/invalid-lead.json "$TMP_DIR/invalid.json")"
  [ "$invalid_status" != "404" ] && break
  sleep 1
done
[ "$invalid_status" = "400" ] || fail "invalid lead with valid auth returned HTTP ${invalid_status}, expected 400 (is the workflow active?)"

python3 - "$TMP_DIR/invalid.json" <<'PY'
import json
import sys

body = json.load(open(sys.argv[1], encoding="utf-8"))
assert body["ok"] is False, body
assert body["error"] == "validation_error", body
assert "name is required." in body["details"], body
assert "At least one of email or phone is required." in body["details"], body
PY

valid_status="$(post "$VALID_LEAD_FILE" "$TMP_DIR/valid.json")"
case "$valid_status" in
  200|201)
    python3 - "$TMP_DIR/valid.json" "$valid_status" <<'PY'
import json
import sys

body = json.load(open(sys.argv[1], encoding="utf-8"))
http_status = sys.argv[2]
assert body["ok"] is True, body
assert body["saved"] is True, body
status = body.get("status")
if status in ("created", "updated"):
    assert body["notified"] is True, body
    print(f"PASS: auth -> 403; invalid -> 400; valid -> {http_status} {status} (CRM + Telegram configured)")
elif status in ("saved_with_notification_error", "updated_with_notification_error"):
    assert body["notified"] is False, body
    print(f"PASS: auth -> 403; invalid -> 400; valid -> {http_status} {status} (lead saved, Telegram failed)")
else:
    raise AssertionError(body)
PY
    ;;
  202)
    python3 - "$TMP_DIR/valid.json" <<'PY'
import json
import sys

body = json.load(open(sys.argv[1], encoding="utf-8"))
assert body["ok"] is True, body
assert body["status"] == "crm_skipped", body
assert isinstance(body.get("saved"), bool), body
print("PASS: auth -> 403; invalid -> 400; valid -> 202 crm_skipped (controlled CRM skip)")
PY
    ;;
  502)
    python3 - "$TMP_DIR/valid.json" <<'PY'
import json
import sys

body = json.load(open(sys.argv[1], encoding="utf-8"))
assert body["ok"] is False, body
assert body["error"] == "crm_write_failed", body
assert body["saved"] is False, body
PY
    echo "PASS: auth -> 403; invalid -> 400; valid -> 502 with crm_write_failed"
    echo "NOTE: 502 means the selected CRM credential/integration is not configured in this instance."
    echo "      This is the expected local result; it is not a successful integration run."
    ;;
  *)
    cat "$TMP_DIR/valid.json" >&2
    fail "valid lead returned HTTP ${valid_status}, expected 200/201/202 (configured/partial/skip) or 502 (integration failure)"
    ;;
esac
