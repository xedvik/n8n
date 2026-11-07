#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

DB_USER="${POSTGRES_USER:-n8n}"
DB_NAME="${POSTGRES_DB:-n8n}"
OPERATION_ID="${1:-}"
RESET_ATTEMPTS=0

if [ -z "$OPERATION_ID" ] || [ "$OPERATION_ID" = "--help" ] || [ "$OPERATION_ID" = "-h" ]; then
  echo "Usage: ./scripts/retry-operation.sh <operation-id> [--reset-attempts]" >&2
  echo "Schedules one specific failed/retry/needs-reconciliation operation for an explicit retry." >&2
  echo "Completed and currently processing operations are refused." >&2
  exit 2
fi
if [ "${2:-}" = "--reset-attempts" ]; then
  RESET_ATTEMPTS=1
elif [ -n "${2:-}" ]; then
  echo "Unknown option: $2" >&2
  exit 2
fi
if ! [[ "$OPERATION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "Operation id must be a UUID: $OPERATION_ID" >&2
  exit 2
fi

if ! docker compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  echo "PostgreSQL container is not running." >&2
  exit 1
fi

row="$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -Atc "select status || '|' || coalesce(crm_status,'') || '|' || coalesce(journal_status,'') || '|' || coalesce(telegram_status,'') || '|' || attempts from app.lead_operations where id='$OPERATION_ID';" | tr -d '\r')"
if [ -z "$row" ]; then
  echo "Operation not found: $OPERATION_ID" >&2
  exit 1
fi
IFS='|' read -r status crm_status journal_status telegram_status attempts <<< "$row"
case "$status" in
  completed)
    echo "Operation is already completed; nothing to retry."
    exit 0
    ;;
  processing)
    echo "Operation is currently processing; refusing to start a concurrent retry." >&2
    echo "If it is genuinely stuck, inspect it and use the Schedule Trigger recovery path." >&2
    exit 1
    ;;
  failed|retry_scheduled|needs_reconciliation|pending)
    ;;
  *)
    echo "Unsupported operation status: $status" >&2
    exit 1
    ;;
esac

echo "Operation: $OPERATION_ID"
echo "Before: status=$status crm=$crm_status journal=$journal_status telegram=$telegram_status attempts=$attempts"
updated="$(docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -Atc "update app.lead_operations set status='retry_scheduled', next_attempt_at=now(), last_error=null, attempts=case when $RESET_ATTEMPTS = 1 then 0 else attempts end, updated_at=now() where id='$OPERATION_ID' and status in ('failed','retry_scheduled','needs_reconciliation','pending') returning id;" | tr -d '\r')"
if [ -z "$updated" ]; then
  echo "Operation state changed before the retry update; refusing to overwrite it. Inspect the operation and retry again." >&2
  exit 1
fi
echo "Scheduled for explicit retry. The Schedule Trigger will claim it on its next run."
echo "Note: confirmed CRM/Journal stages are preserved; only unfinished stages are retried."
