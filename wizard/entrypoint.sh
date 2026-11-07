#!/bin/sh
set -eu

DATA_DIR="${WIZARD_DATA_DIR:-/data}"

# The official installer provisions this token before starting the stack.
# Direct `docker compose up` must also work: generate a one-time token on the
# first server-mode start, without weakening auth.mjs's fail-closed checks.
if [ "${WIZARD_SERVER_MODE:-0}" = "1" ] \
  && [ ! -f "$DATA_DIR/auth.json" ] \
  && [ ! -f "$DATA_DIR/bootstrap-token" ] \
  && [ -z "${WIZARD_BOOTSTRAP_TOKEN:-}" ]; then
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR" 2>/dev/null || true
  umask 077
  TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  printf '%s\n' "$TOKEN" > "$DATA_DIR/bootstrap-token"
  chmod 600 "$DATA_DIR/bootstrap-token" 2>/dev/null || true
  echo "CRM Setup Wizard: generated bootstrap token at $DATA_DIR/bootstrap-token"
fi

# Make the first-run token readable by the host operator when the installer
# provided the intended UID/GID. The token value is never written to logs.
if [ "${WIZARD_CONFIG_UID:-0}" != "0" ] || [ "${WIZARD_CONFIG_GID:-0}" != "0" ]; then
  chown "$WIZARD_CONFIG_UID:$WIZARD_CONFIG_GID" "$DATA_DIR" 2>/dev/null || true
  chown "$WIZARD_CONFIG_UID:$WIZARD_CONFIG_GID" "$DATA_DIR/bootstrap-token" 2>/dev/null || true
fi

exec node wizard/server.mjs
