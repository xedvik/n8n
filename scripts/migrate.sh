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

if ! docker compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  echo "PostgreSQL container is not running. Start it with: docker compose up -d postgres" >&2
  exit 1
fi

for migration in db/migrations/*.sql; do
  echo "Applying ${migration}"
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${DB_USER}" -d "${DB_NAME}" < "${migration}" >/dev/null
done

docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${DB_USER}" -d "${DB_NAME}" -c "select to_regclass('app.lead_operations') as lead_operations, to_regprocedure('app.reserve_lead_operation(text,text,text,text,jsonb,boolean,integer,integer,uuid)') as reserve_fn, to_regprocedure('app.save_operation_state(uuid,jsonb)') as save_fn, to_regprocedure('app.cleanup_lead_operations(integer)') as cleanup_fn;"
echo "Migrations applied."
