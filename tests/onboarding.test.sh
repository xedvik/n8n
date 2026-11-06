#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CONFIG="$TMP_DIR/client.json"

CONFIG_FILE="$CONFIG" SETUP_NONINTERACTIVE=1 \
CLIENT_NAME="Onboarding Test" CLIENT_TIMEZONE="Asia/Tbilisi" SOURCE_DEFAULT="landing" \
CRM_PROVIDER="google_sheets" GOOGLE_SHEETS_ID="sheet-onboarding-test" LEADS_SHEET="Leads" \
JOURNAL_ENABLED=false TELEGRAM_ENABLED=false ERRORS_ENABLED=false \
bash scripts/setup-client.sh >/dev/null

node scripts/config-check.mjs "$CONFIG" > "$TMP_DIR/normalized.json"
python3 - "$TMP_DIR/normalized.json" <<'PY'
import json
import sys
config = json.load(open(sys.argv[1], encoding="utf-8"))
assert config["version"] == 2
assert config["clientName"] == "Onboarding Test"
assert config["timezone"] == "Asia/Tbilisi"
assert config["crm"]["provider"] == "google_sheets"
assert config["crm"]["googleSheets"]["spreadsheetId"] == "sheet-onboarding-test"
assert config["journal"]["enabled"] is False
assert config["notifications"]["enabled"] is False
print("PASS: setup-client created and validated a new client config")
PY

CONFIG_FILE="$CONFIG" SETUP_NONINTERACTIVE=1 CLIENT_TIMEZONE="Asia/Tbilisi" \
CRM_PROVIDER="google_sheets" GOOGLE_SHEETS_ID="sheet-onboarding-test" LEADS_SHEET="Leads" \
JOURNAL_ENABLED=false TELEGRAM_ENABLED=false ERRORS_ENABLED=false \
bash scripts/setup-client.sh >/dev/null

node scripts/config-check.mjs "$CONFIG" > "$TMP_DIR/normalized-rerun.json"
python3 - "$TMP_DIR/normalized-rerun.json" <<'PY'
import json
import sys
config = json.load(open(sys.argv[1], encoding="utf-8"))
assert config["clientName"] == "Onboarding Test"
assert config["timezone"] == "Asia/Tbilisi"
assert config["crm"]["googleSheets"]["spreadsheetId"] == "sheet-onboarding-test"
print("PASS: setup-client rerun preserved existing settings")
PY

bash scripts/doctor.sh > "$TMP_DIR/doctor.log" 2>&1
grep -q 'RESULT: PASS' "$TMP_DIR/doctor.log"
echo "PASS: doctor.sh reports PASS"
