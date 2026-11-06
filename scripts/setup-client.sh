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
  echo "ОШИБКА: $*" >&2
  exit 1
}

need_value() {
  local name="$1" value="$2"
  [ -n "$value" ] || fail "$name: значение обязательно"
  case "$value" in
    REPLACE_WITH_*|CHANGE_ME*) fail "$name: значение всё ещё является placeholder (замените его)" ;;
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
  fail "Node.js не установлен, и контейнер n8n не запущен. Запустите Docker Compose или установите Node.js."
}

if [ -f "$CONFIG_FILE" ]; then
  normalize_or_validate "$CONFIG_FILE" "$NORMALIZED_FILE" || fail "Существующий $CONFIG_FILE невалиден; исправьте его перед повторным запуском setup."
  cp "$NORMALIZED_FILE" "$BASE_FILE"
  echo "Использую существующий конфиг: $CONFIG_FILE"
else
  cp "$TEMPLATE_FILE" "$BASE_FILE"
  echo "Использую шаблон: $TEMPLATE_FILE"
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
        *) echo "Пожалуйста, ответьте y или n." ;;
      esac
    done
  fi
  case "$value" in
    y|Y|yes|YES|1|true|TRUE) printf 'true' ;;
    *) printf 'false' ;;
  esac
}

client_name="$(ask 'Имя клиента' "$(json_get clientName)" CLIENT_NAME)"
timezone="$(ask 'Часовой пояс клиента (IANA, например Asia/Tbilisi)' "$(json_get timezone)" CLIENT_TIMEZONE)"
source_default="$(ask 'Источник заявки по умолчанию' "$(json_get source.defaultSource)" SOURCE_DEFAULT)"
crm_provider="$(ask 'CRM-провайдер (hubspot/google_sheets/none)' "$(json_get crm.provider)" CRM_PROVIDER)"
case "$crm_provider" in
  hubspot|google_sheets|none) ;;
  *) fail "CRM-провайдер должен быть hubspot, google_sheets или none" ;;
esac

sheet_id="$(json_get crm.googleSheets.spreadsheetId)"
leads_sheet="$(json_get crm.googleSheets.leadsSheetName)"
hubspot_base="$(json_get crm.hubspot.baseUrl)"
if [ "$crm_provider" = "google_sheets" ]; then
  sheet_id="$(ask 'ID Google-таблицы CRM' "$sheet_id" GOOGLE_SHEETS_ID)"
  leads_sheet="$(ask 'Имя листа с заявками CRM' "${leads_sheet:-Leads}" LEADS_SHEET)"
  need_value "ID Google-таблицы CRM" "$sheet_id"
  need_value "Имя листа CRM" "$leads_sheet"
fi
if [ "$crm_provider" = "hubspot" ]; then
  hubspot_base="$(ask 'Базовый URL HubSpot API' "${hubspot_base:-https://api.hubapi.com}" HUBSPOT_BASE_URL)"
fi

journal_enabled="$(ask_yn 'Включить отдельный журнал Google Sheets?' "$(json_get journal.enabled)" JOURNAL_ENABLED)"
journal_id="$(json_get journal.googleSheets.spreadsheetId)"
journal_sheet="$(json_get journal.googleSheets.sheetName)"
if [ "$journal_enabled" = "true" ]; then
  journal_default_id="${journal_id:-$sheet_id}"
  journal_id="$(ask 'ID Google-таблицы журнала' "$journal_default_id" JOURNAL_SHEET_ID)"
  journal_sheet="$(ask 'Имя листа журнала' "${journal_sheet:-Journal}" JOURNAL_SHEET)"
  need_value "ID Google-таблицы журнала" "$journal_id"
  need_value "Имя листа журнала" "$journal_sheet"
fi

notifications_enabled="$(ask_yn 'Включить уведомления Telegram?' "$(json_get notifications.enabled)" TELEGRAM_ENABLED)"
telegram_chat_id="$(json_get notifications.telegram.chatId)"
telegram_template="$(json_get notifications.telegram.messageTemplate)"
if [ "$notifications_enabled" = "true" ]; then
  telegram_chat_id="$(ask 'Telegram chat ID' "$telegram_chat_id" TELEGRAM_CHAT_ID)"
  need_value "Telegram chat ID" "$telegram_chat_id"
  if [ -n "${TELEGRAM_MESSAGE_TEMPLATE:-}" ]; then
    telegram_template="$TELEGRAM_MESSAGE_TEMPLATE"
  fi
fi

errors_enabled="$(ask_yn 'Включить журнал ошибок Google Sheets?' "$(json_get errors.enabled)" ERRORS_ENABLED)"
errors_id="$(json_get errors.googleSheets.spreadsheetId)"
errors_sheet="$(json_get errors.googleSheets.sheetName)"
if [ "$errors_enabled" = "true" ]; then
  errors_default_id="${errors_id:-${journal_id:-$sheet_id}}"
  errors_id="$(ask 'ID Google-таблицы журнала ошибок' "$errors_default_id" ERRORS_SHEET_ID)"
  errors_sheet="$(ask 'Имя листа журнала ошибок' "${errors_sheet:-Errors}" ERRORS_SHEET)"
  need_value "ID Google-таблицы журнала ошибок" "$errors_id"
  need_value "Имя листа журнала ошибок" "$errors_sheet"
fi

CLIENT_NAME="$client_name" \
CLIENT_TIMEZONE="$timezone" \
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
base["timezone"] = text("CLIENT_TIMEZONE") or base.get("timezone", "UTC")
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

normalize_or_validate "$NEW_FILE" "$TMP_DIR/validated.json" || fail "Сгенерированный конфиг невалиден; существующий $CONFIG_FILE не изменён."
mv "$NEW_FILE" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE" 2>/dev/null || true

echo
echo "Конфигурация записана: $CONFIG_FILE"
echo "Далее назначьте credentials в n8n (они не хранятся в client.json)."
echo
echo "Подсказки по credentials:"
echo "- Header Auth: имя заголовка X-Webhook-Secret; значение из .env LEAD_WEBHOOK_SECRET; назначить ноде Lead Webhook."
if [ "$crm_provider" = "google_sheets" ] || [ "$journal_enabled" = "true" ] || [ "$errors_enabled" = "true" ]; then
  echo "- Google Sheets OAuth2 API (или Google Service Account): назначить нодам CRM, Journal и Error Log."
fi
if [ "$crm_provider" = "hubspot" ]; then
  echo "- HubSpot Service Key (OAuth2 опционально): назначить нодам HubSpot Search Contact, HubSpot Create Contact и HubSpot Update Contact."
fi
if [ "$notifications_enabled" = "true" ]; then
  echo "- Telegram API: назначить ноде Notification Adapter - Telegram."
fi
echo
if [[ "$CONFIG_FILE" = /* ]]; then
  echo "В .env укажите: LEAD_CONFIG_FILE=${CONFIG_FILE}"
else
  echo "В .env укажите: LEAD_CONFIG_FILE=./${CONFIG_FILE}"
fi
echo "Конфиг читается на каждом запросе; перезапуск n8n не нужен. Если меняли compose/volume — выполните docker compose up -d."
echo "Запустите: ./scripts/doctor.sh"
