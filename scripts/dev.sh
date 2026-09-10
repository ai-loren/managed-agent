#!/usr/bin/env bash
#
# One-command launch for the Managed-Agent demo — the web console and its API,
# which are the same process (the server serves the console at `/`).
#
# It loads .env.demo (your OpenRouter key, gitignored), installs deps if needed,
# starts the demo server, waits until it is listening, opens the browser, and
# streams the server's output. Ctrl-C stops it cleanly.
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# --- Load local config (never committed) -----------------------------------
if [[ -f .env.demo ]]; then
  echo "→ loading .env.demo"
  set -a
  # shellcheck disable=SC1091
  source .env.demo
  set +a
else
  echo "→ no .env.demo found; running with the offline echo model."
  echo "  Copy .env.demo.example to .env.demo and add an OpenRouter key for a real model."
fi

# --- Install dependencies once ---------------------------------------------
if [[ ! -d node_modules ]]; then
  echo "→ installing dependencies (first run)…"
  pnpm install --frozen-lockfile
fi

PORT="${MA_PORT:-8080}"
HOST="${MA_HOST:-127.0.0.1}"
URL="http://${HOST}:${PORT}/"
LOG="$(mktemp -t ma-demo.XXXXXX)"

cleanup() {
  # Stop the server and its process group; remove the temp log.
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG"
}
trap cleanup INT TERM EXIT

echo "→ starting the demo server…"
# The server prints its banner (URL, token, workspace) to stderr; tee it so the
# user sees it live and this script can wait on the readiness line.
node apps/server/src/demo.ts >"$LOG" 2>&1 &
SERVER_PID=$!

# --- Wait for readiness -----------------------------------------------------
for _ in $(seq 1 120); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "✗ the server exited during startup:" >&2
    cat "$LOG" >&2
    exit 1
  fi
  if grep -q "Managed-Agent demo is running" "$LOG" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

# Show the banner the server printed.
cat "$LOG"

# --- Open the browser -------------------------------------------------------
if command -v open >/dev/null 2>&1; then
  open "$URL" || true            # macOS
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true   # Linux
else
  echo "→ open ${URL} in your browser."
fi

echo ""
echo "→ streaming server logs (Ctrl-C to stop)…"
echo ""

# Follow the log in the foreground until the server exits or the user interrupts.
tail -f "$LOG" &
TAIL_PID=$!
wait "$SERVER_PID"
kill "$TAIL_PID" 2>/dev/null || true
