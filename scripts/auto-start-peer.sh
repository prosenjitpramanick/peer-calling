#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/peer-server.log"
PORT="${PORT:-4000}"
RESTART_DELAY="${RESTART_DELAY:-5}"

mkdir -p "$LOG_DIR"

echo "[auto-start-peer] Using APP_DIR=$APP_DIR PORT=$PORT" | tee -a "$LOG_FILE"

while true; do
  echo "[auto-start-peer] $(date --iso-8601=seconds) starting npm start" | tee -a "$LOG_FILE"
  (
    cd "$APP_DIR"
    PORT="$PORT" npm start >>"$LOG_FILE" 2>&1
  )
  exit_code=$?
  echo "[auto-start-peer] npm start exited with $exit_code, restarting in ${RESTART_DELAY}s" | tee -a "$LOG_FILE"
  sleep "$RESTART_DELAY"
 done
