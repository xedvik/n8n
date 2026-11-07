#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

CONFIG_FILE="${LEAD_CONFIG_FILE:-./config/client.json}"
CONFIG_FILE="${CONFIG_FILE#./}"
DB_USER="${POSTGRES_USER:-n8n}"
DB_NAME="${POSTGRES_DB:-n8n}"
DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "" ) ;;
  --help|-h)
    echo "Usage: ./scripts/cleanup-operations.sh [--dry-run]"
    exit 0
    ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Client config not found: $CONFIG_FILE" >&2
  exit 1
fi
RETENTION_DAYS="$(python3 - "$CONFIG_FILE" <<'PY'
import json, sys
config = json.load(open(sys.argv[1], encoding='utf-8'))
value = (config.get('idempotency') or {}).get('retentionDays', 30)
try:
    value = int(value)
except (TypeError, ValueError):
    value = 0
if value < 1 or value > 3650:
    raise SystemExit('idempotency.retentionDays must be an integer between 1 and 3650')
print(value)
PY
)" || exit 1

if [ "$DRY_RUN" = "1" ]; then
  docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -c "select count(*) as operations_would_delete from app.lead_operations where status in ('completed','failed') and updated_at < now() - make_interval(days => $RETENTION_DAYS);"
else
  docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -c "select app.cleanup_lead_operations($RETENTION_DAYS) as operations_deleted;"
fi
