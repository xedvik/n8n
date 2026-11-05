#!/usr/bin/env bash
set -euo pipefail

WORKFLOW_ID="${WORKFLOW_ID:-7c9f5a2e-3b4d-4f6a-9c1e-2d8b7a6f5e40}"
BASE_URL="${BASE_URL:-http://127.0.0.1:5678}"

until curl -fsS "${BASE_URL}/healthz/readiness" >/dev/null 2>&1; do
  echo "Waiting for n8n at ${BASE_URL} ..."
  sleep 2
done

existing_id="$(docker compose exec -T n8n n8n list:workflow --onlyId 2>/dev/null | tr -d '\r' | grep -Fx "${WORKFLOW_ID}" || true)"
if [ -n "${existing_id}" ] && [ "${ALLOW_REIMPORT:-0}" != "1" ]; then
  echo "Workflow ${WORKFLOW_ID} already exists. Re-importing a credential-free export can clear" >&2
  echo "Google/Telegram credential assignments. Use the n8n UI for updates, or set" >&2
  echo "ALLOW_REIMPORT=1 and re-assign credentials afterwards." >&2
  exit 1
fi

docker compose exec -T n8n n8n import:workflow --input=/home/node/workflows/lead-intake.json
docker compose exec -T n8n n8n publish:workflow --id="${WORKFLOW_ID}"

# n8n 2.x picks up a newly published webhook after a process restart.
docker compose restart n8n >/dev/null

until curl -fsS "${BASE_URL}/healthz/readiness" >/dev/null 2>&1; do
  sleep 2
done

# healthz can answer before the production webhook is registered after a restart.
ready=0
for _ in $(seq 1 30); do
  status="$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "${BASE_URL}/webhook/lead-intake" \
    -H 'Content-Type: application/json' \
    --data '{}' || true)"
  if [ "$status" != "000" ] && [ "$status" != "404" ]; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" != "1" ]; then
  echo "Workflow was published, but the production webhook did not become ready." >&2
  echo "Check: docker compose logs --tail=100 n8n" >&2
  exit 1
fi

echo "Workflow ${WORKFLOW_ID} imported, published and active."
