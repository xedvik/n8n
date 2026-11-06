#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CONFIG_FILE="${CONFIG_FILE:-config/client.json}"
TEMPLATE_FILE="${TEMPLATE_FILE:-config/example-client.json}"
NONINTERACTIVE="${SETUP_NONINTERACTIVE:-0}"
TMP_DIR="$(mktemp -d)"
CONFIG_DIR="$(dirname "$CONFIG_FILE")"
mkdir -p "$CONFIG_DIR"
BASE_FILE="$TMP_DIR/base.json"
NEW_FILE="$(mktemp "${CONFIG_DIR}/.client-config.XXXXXX")"
NORMALIZED_FILE="$TMP_DIR/normalized.json"
trap 'rm -rf "$TMP_DIR"; rm -f "$NEW_FILE"' EXIT

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

need_value() {
  local name="$1" value="$2"
  [ -n "$value" ] || fail "$name is required"
  case "$value" in
    REPLACE_WITH_*|CHANGE_ME*) fail "$name still contains a placeholder value" ;;
  esac
}

normalize_or_validate() {
  local input="$1" output="$2"
  if command -v node >/dev/null 2>&1; then
    node scripts/config-check.mjs "$input" > "$output"
    return
  fi
  if docker compose ps --status running --services 2>/dev/null | grep -qx n8n; then
    docker compose cp "$input" n8n:/tmp/setup-config.json >/dev/null
    docker compose exec -T n8n node /home/node/scripts/config-check.mjs /tmp/setup-config.json > "$output"
    docker compose exec -T n8n rm -f /tmp/setup-config.json >/dev/null 2>&1 || true
    return
  fi
  fail "Node.js is not installed and the n8n container is not running. Start Docker Compose or install Node.js."
}

if [ -f "$CONFIG_FILE" ]; then
  normalize_or_validate "$CONFIG_FILE" "$NORMALIZED_FILE" || fail "Existing $CONFIG_FILE is invalid; fix it before rerunning setup."
  cp "$NORMALIZED_FILE" "$BASE_FILE"
  echo "Using existing config: $CONFIG_FILE"
else
  cp "$TEMPLATE_FILE" "$BASE_FILE"
  echo "Using template: $TEMPLATE_FILE"
fi

json_get() {
  python3 - "$BASE_FILE" "$1" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1], encoding="utf-8"))
for part in sys.argv[2].split("."):
    if not isinstance(value, dict):
        value = None
        break
    value = value.get(part)
if value is None:
    print("")
elif isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

ask() {
  local prompt="$1" default="$2" env_name="$3" value
  if [ "$NONINTERACTIVE" = "1" ]; then
    if [ -n "${!env_name:-}" ]; then
      printf '%s' "${!env_name}"
    else
      printf '%s' "$default"
    fi
    return
  fi
  read -r -p "$prompt [$default]: " value || true
  printf '%s' "${value:-$default}"
}

ask_yn() {
  local prompt="$1" default="$2" env_name="$3" value
  if [ "$NONINTERACTIVE" = "1" ]; then
    value="${!env_name:-$default}"
  else
    while true; do
      read -r -p "$prompt [$default] (y/n): " value || true
      value="${value:-$default}"
      case "$value" in
        y|Y|yes|YES|1|true|TRUE|n|N|no|NO|0|false|FALSE) break ;;
        *) echo "Please answer y or n." ;;
      esac
    done
  fi
  case "$value" in
    y|Y|yes|YES|1|true|TRUE) printf 'true' ;;
    *) printf 'false' ;;
  esac
}

client_name="$(ask 'Client name' "$(json_get clientName)" CLIENT_NAME)"
source_default="$(ask 'Default lead source' "$(json_get source.defaultSource)" SOURCE_DEFAULT)"
crm_provider="$(ask 'CRM provider (hubspot/google_sheets/none)' "$(json_get crm.provider)" CRM_PROVIDER)"
case "$crm_provider" in
  hubspot|google_sheets|none) ;;
  *) fail "CRM provider must be hubspot, google_sheets or none" ;;
esac

sheet_id="$(json_get crm.googleSheets.spreadsheetId)"
leads_sheet="$(json_get crm.googleSheets.leadsSheetName)"
hubspot_base="$(json_get crm.hubspot.baseUrl)"
if [ "$crm_provider" = "google_sheets" ]; then
  sheet_id="$(ask 'CRM Google Sheets spreadsheet ID' "$sheet_id" GOOGLE_SHEETS_ID)"
  leads_sheet="$(ask 'CRM leads sheet name' "${leads_sheet:-Leads}" LEADS_SHEET)"
  need_value "CRM spreadsheet ID" "$sheet_id"
  need_value "CRM leads sheet" "$leads_sheet"
fi
if [ "$crm_provider" = "hubspot" ]; then
  hubspot_base="$(ask 'HubSpot API base URL' "${hubspot_base:-https://api.hubapi.com}" HUBSPOT_BASE_URL)"
fi

journal_enabled="$(ask_yn 'Enable independent Google Sheets journal?' "$(json_get journal.enabled)" JOURNAL_ENABLED)"
journal_id="$(json_get journal.googleSheets.spreadsheetId)"
journal_sheet="$(json_get journal.googleSheets.sheetName)"
if [ "$journal_enabled" = "true" ]; then
  journal_default_id="${journal_id:-$sheet_id}"
  journal_id="$(ask 'Journal spreadsheet ID' "$journal_default_id" JOURNAL_SHEET_ID)"
  journal_sheet="$(ask 'Journal sheet name' "${journal_sheet:-Journal}" JOURNAL_SHEET)"
  need_value "Journal spreadsheet ID" "$journal_id"
  need_value "Journal sheet name" "$journal_sheet"
fi

notifications_enabled="$(ask_yn 'Enable Telegram notifications?' "$(json_get notifications.enabled)" TELEGRAM_ENABLED)"
telegram_chat_id="$(json_get notifications.telegram.chatId)"
telegram_template="$(json_get notifications.telegram.messageTemplate)"
if [ "$notifications_enabled" = "true" ]; then
  telegram_chat_id="$(ask 'Telegram chat ID' "$telegram_chat_id" TELEGRAM_CHAT_ID)"
  need_value "Telegram chat ID" "$telegram_chat_id"
  if [ -n "${TELEGRAM_MESSAGE_TEMPLATE:-}" ]; then
    telegram_template="$TELEGRAM_MESSAGE_TEMPLATE"
  fi
fi

errors_enabled="$(ask_yn 'Enable Google Sheets error log?' "$(json_get errors.enabled)" ERRORS_ENABLED)"
errors_id="$(json_get errors.googleSheets.spreadsheetId)"
errors_sheet="$(json_get errors.googleSheets.sheetName)"
if [ "$errors_enabled" = "true" ]; then
  errors_default_id="${errors_id:-${journal_id:-$sheet_id}}"
  errors_id="$(ask 'Error log spreadsheet ID' "$errors_default_id" ERRORS_SHEET_ID)"
  errors_sheet="$(ask 'Error log sheet name' "${errors_sheet:-Errors}" ERRORS_SHEET)"
  need_value "Error log spreadsheet ID" "$errors_id"
  need_value "Error log sheet name" "$errors_sheet"
fi

CLIENT_NAME="$client_name" \
SOURCE_DEFAULT="$source_default" \
CRM_PROVIDER="$crm_provider" \
GOOGLE_SHEETS_ID="$sheet_id" \
LEADS_SHEET="$leads_sheet" \
HUBSPOT_BASE_URL="$hubspot_base" \
JOURNAL_ENABLED="$journal_enabled" \
JOURNAL_SHEET_ID="$journal_id" \
JOURNAL_SHEET="$journal_sheet" \
TELEGRAM_ENABLED="$notifications_enabled" \
TELEGRAM_CHAT_ID="$telegram_chat_id" \
TELEGRAM_MESSAGE_TEMPLATE="$telegram_template" \
ERRORS_ENABLED="$errors_enabled" \
ERRORS_SHEET_ID="$errors_id" \
ERRORS_SHEET="$errors_sheet" \
BASE_FILE="$BASE_FILE" \
TEMPLATE_FILE="$TEMPLATE_FILE" \
OUTPUT_FILE="$NEW_FILE" \
python3 - <<'PY'
import json
import os
from pathlib import Path

base = json.load(open(os.environ["BASE_FILE"], encoding="utf-8"))
template = json.load(open(os.environ["TEMPLATE_FILE"], encoding="utf-8"))

def bool_value(name):
    return os.environ[name] == "true"

def text(name):
    return os.environ.get(name, "").strip()

base.setdefault("version", 2)
base["clientName"] = text("CLIENT_NAME") or base.get("clientName", "Client")
base.setdefault("source", {})["type"] = "webhook"
base["source"]["defaultSource"] = text("SOURCE_DEFAULT") or "unknown"

crm = base.setdefault("crm", {})
crm["provider"] = text("CRM_PROVIDER")

if crm["provider"] == "google_sheets":
    sheets = crm.get("googleSheets") or template["crm"]["googleSheets"]
    sheets["spreadsheetId"] = text("GOOGLE_SHEETS_ID")
    sheets["leadsSheetName"] = text("LEADS_SHEET")
    sheets.setdefault("columns", template["crm"]["googleSheets"]["columns"])
    crm["googleSheets"] = sheets
else:
    crm.setdefault("googleSheets", template["crm"]["googleSheets"])

if crm["provider"] == "hubspot":
    hubspot = crm.get("hubspot") or template["crm"]["hubspot"]
    hubspot["baseUrl"] = text("HUBSPOT_BASE_URL") or "https://api.hubapi.com"
    hubspot["phoneOnlyPolicy"] = "skip"
    hubspot.setdefault("searchEmailProperty", "email")
    hubspot.setdefault("searchLimit", 10)
    hubspot.setdefault("propertiesToReturn", ["email", "phone", "firstname", "lastname"])
    hubspot.setdefault("propertyMapping", template["crm"]["hubspot"]["propertyMapping"])
    crm["hubspot"] = hubspot

journal = base.get("journal") or {}
journal.setdefault("provider", "google_sheets")
journal_sheets = journal.get("googleSheets") or template["journal"]["googleSheets"]
if text("JOURNAL_SHEET_ID"):
    journal_sheets["spreadsheetId"] = text("JOURNAL_SHEET_ID")
if text("JOURNAL_SHEET"):
    journal_sheets["sheetName"] = text("JOURNAL_SHEET")
journal_sheets.setdefault("columns", template["journal"]["googleSheets"]["columns"])
journal["googleSheets"] = journal_sheets
journal["enabled"] = bool_value("JOURNAL_ENABLED")
base["journal"] = journal

notifications = base.get("notifications") or {}
notifications.setdefault("channels", ["telegram"])
telegram = notifications.get("telegram") or template["notifications"]["telegram"]
if text("TELEGRAM_CHAT_ID"):
    telegram["chatId"] = text("TELEGRAM_CHAT_ID")
if text("TELEGRAM_MESSAGE_TEMPLATE"):
    telegram["messageTemplate"] = text("TELEGRAM_MESSAGE_TEMPLATE")
telegram.setdefault("messageTemplate", template["notifications"]["telegram"]["messageTemplate"])
notifications["telegram"] = telegram
notifications["enabled"] = bool_value("TELEGRAM_ENABLED")
notifications["channels"] = ["telegram"] if notifications["enabled"] else notifications.get("channels", [])
base["notifications"] = notifications

errors = base.get("errors") or {}
errors.setdefault("provider", "google_sheets")
error_sheets = errors.get("googleSheets") or template["errors"]["googleSheets"]
if text("ERRORS_SHEET_ID"):
    error_sheets["spreadsheetId"] = text("ERRORS_SHEET_ID")
if text("ERRORS_SHEET"):
    error_sheets["sheetName"] = text("ERRORS_SHEET")
error_sheets.setdefault("columns", template["errors"]["googleSheets"]["columns"])
errors["googleSheets"] = error_sheets
errors["enabled"] = bool_value("ERRORS_ENABLED")
base["errors"] = errors

Path(os.environ["OUTPUT_FILE"]).write_text(json.dumps(base, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

normalize_or_validate "$NEW_FILE" "$TMP_DIR/validated.json" || fail "Generated config is invalid; existing $CONFIG_FILE was not changed."
mv "$NEW_FILE" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE" 2>/dev/null || true

echo
echo "Configuration written: $CONFIG_FILE"
echo "Next: assign credentials in n8n (n8n does not store them in client.json)."
echo
echo "Required credential hints:"
echo "- Header Auth: header name X-Webhook-Secret; value from .env LEAD_WEBHOOK_SECRET; assign to Lead Webhook."
if [ "$crm_provider" = "google_sheets" ] || [ "$journal_enabled" = "true" ] || [ "$errors_enabled" = "true" ]; then
  echo "- Google Sheets OAuth2 API (or Google Service Account): assign to CRM, Journal and Error Log Google Sheets nodes."
fi
if [ "$crm_provider" = "hubspot" ]; then
  echo "- HubSpot Service Key (OAuth2 optional): assign to HubSpot Search Contact, HubSpot Create Contact and HubSpot Update Contact."
fi
if [ "$notifications_enabled" = "true" ]; then
  echo "- Telegram API: assign to Notification Adapter - Telegram."
fi
echo
if [[ "$CONFIG_FILE" = /* ]]; then
  echo "In .env set: LEAD_CONFIG_FILE=${CONFIG_FILE}"
else
  echo "In .env set: LEAD_CONFIG_FILE=./${CONFIG_FILE}"
fi
echo "Then restart n8n: docker compose up -d"
echo "Run: ./scripts/doctor.sh"
