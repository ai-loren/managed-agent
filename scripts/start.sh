#!/usr/bin/env bash
#
# start.sh — one command to run Managed-Agent locally, with options.
#
# Two modes:
#   demo (default)  console + API + an injected model (OpenRouter if a key is
#                   given, otherwise an offline echo model) and a seeded Demo
#                   workspace. The best "kick the tyres" experience.
#   prod            the real server (apps/server/src/main.ts). It wires no model
#                   provider, so it is for managing the platform, not running a
#                   real model turn.
#
# Examples:
#   ./scripts/start.sh                         # demo, offline echo, :8080, open browser
#   ./scripts/start.sh --no-open               # demo but don't open a browser
#   ./scripts/start.sh --port 9090 --host 0.0.0.0
#   ./scripts/start.sh --memory                 # ephemeral in-memory database
#   ./scripts/start.sh --database ./data/x.db   # explicit file database
#   ./scripts/start.sh --openrouter-key sk_...  # demo against a real model
#   ./scripts/start.sh --model vendor/model:free
#   ./scripts/start.sh --prod --token s3cret    # production server, fixed admin token
#   ./scripts/start.sh --sandbox-driver container
#   ./scripts/start.sh --foreground             # foreground logs, Ctrl-C to stop (default)
#
# Environment variables the underlying server reads (set to override anything
# not exposed as a flag): MA_ENCRYPTION_KEYS, MA_CORS_ORIGINS, MA_EGRESS_PROXY,
# MA_VOLUME_ROOT, etc. See apps/server/src/config.ts for the full list.
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# --- Defaults --------------------------------------------------------------
MODE="demo"
HOST="127.0.0.1"
PORT="8080"
DATABASE=""                 # empty => mode default (demo: :memory:, prod: ./data/...)
LOG_LEVEL=""
SANDBOX_DRIVER=""
OPEN_ROUTER_KEY=""
MODEL=""
BOOTSTRAP_TOKEN=""
OPEN_BROWSER="auto"         # auto | always | never
LOAD_DEMO_ENV="true"        # source .env.demo if present (demo mode)
NO_INSTALL="false"

usage() {
  cat <<'USAGE'
start.sh — run Managed-Agent locally

Modes:
  demo (default)  console + API + injected model (OpenRouter if a key is given,
                  otherwise an offline echo model) and a seeded Demo workspace.
  prod            the real server (no model provider wired); manage the platform.

Examples:
  ./scripts/start.sh                            demo, echo model, :8080, opens browser
  ./scripts/start.sh --no-open
  ./scripts/start.sh --port 9090 --host 0.0.0.0
  ./scripts/start.sh --memory                   ephemeral in-memory database
  ./scripts/start.sh --database ./data/x.db
  ./scripts/start.sh --openrouter-key sk_...    real model
  ./scripts/start.sh --model vendor/model:free
  ./scripts/start.sh --prod --token s3cret      production server, fixed admin token
  ./scripts/start.sh --sandbox-driver container

Options:
  -m, --mode <demo|prod>     demo = model + seeded workspace (default);
                             prod = real server with no model provider
      --prod                 shorthand for --mode prod
      --demo                 shorthand for --mode demo (the default)
  -h, --host <addr>          bind address (default 127.0.0.1; 0.0.0.0 for LAN)
  -p, --port <number>        port (default 8080)
  -d, --database <path>      SQLite file path (prod default ./data/managed-agent.db)
      --memory               use an ephemeral in-memory database (:memory:)
  -l, --log-level <level>    debug | info | warn | error (default info)
      --sandbox-driver <d>   local | container | k8s (default local)
  -k, --openrouter-key <k>   demo only: an OpenRouter key (enables a real model)
      --model <id>           demo only: OpenRouter model id (e.g. x/y:free)
  -t, --token <token>        fix the bootstrap admin token instead of a random one
      --open                 always open the browser
      --no-open              never open the browser
      --no-demo-env          do not source .env.demo even if it exists
      --no-install           do not run pnpm install if node_modules is missing
      --help                 show this help

Unlisted server settings (MA_ENCRYPTION_KEYS, MA_CORS_ORIGINS, MA_EGRESS_PROXY,
MA_VOLUME_ROOT, …) are read straight from the environment; see
apps/server/src/config.ts for the full list.
USAGE
}

# --- Parse args ------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    -m|--mode) MODE="${2:?missing value for $1}"; shift 2 ;;
    --prod) MODE="prod"; shift ;;
    --demo) MODE="demo"; shift ;;
    --host) HOST="${2:?missing value for $1}"; shift 2 ;;
    -p|--port) PORT="${2:?missing value for $1}"; shift 2 ;;
    -d|--database) DATABASE="${2:?missing value for $1}"; shift 2 ;;
    --memory) DATABASE=":memory:"; shift ;;
    -l|--log-level) LOG_LEVEL="${2:?missing value for $1}"; shift 2 ;;
    --sandbox-driver) SANDBOX_DRIVER="${2:?missing value for $1}"; shift 2 ;;
    -k|--openrouter-key) OPEN_ROUTER_KEY="${2:?missing value for $1}"; shift 2 ;;
    --model) MODEL="${2:?missing value for $1}"; shift 2 ;;
    -t|--token) BOOTSTRAP_TOKEN="${2:?missing value for $1}"; shift 2 ;;
    --open) OPEN_BROWSER="always"; shift ;;
    --no-open) OPEN_BROWSER="never"; shift ;;
    --no-demo-env) LOAD_DEMO_ENV="false"; shift ;;
    --no-install) NO_INSTALL="true"; shift ;;
    --help|-?) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; echo "run with --help" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  demo|prod) ;;
  *) echo "invalid --mode '$MODE' (expected demo or prod)" >&2; exit 2 ;;
esac
case "$PORT" in
  ''|*[!0-9]*) echo "invalid --port '$PORT'" >&2; exit 2 ;;
esac

# Demo mode defaults the database to in-memory (no residue); prod defaults to
# the durable file path the server itself would choose.
if [ -z "$DATABASE" ]; then
  if [ "$MODE" = "demo" ]; then DATABASE=":memory:"; else DATABASE="./data/managed-agent.db"; fi
fi

# --- Optionally load .env.demo (demo mode only) ----------------------------
if [ "$MODE" = "demo" ] && [ "$LOAD_DEMO_ENV" = "true" ] && [ -f "$ROOT/.env.demo" ]; then
  echo "→ loading .env.demo (override with --no-demo-env)"
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.demo"
  set +a
fi

# Explicit flags win over values sourced from .env.demo / the ambient env, so
# export only what the flags actually set.
export MA_HOST="$HOST"
export MA_PORT="$PORT"
export MA_DATABASE="$DATABASE"
[ -n "$LOG_LEVEL" ] && export MA_LOG_LEVEL="$LOG_LEVEL"
[ -n "$SANDBOX_DRIVER" ] && export MA_SANDBOX_DRIVER="$SANDBOX_DRIVER"
[ -n "$BOOTSTRAP_TOKEN" ] && export MA_BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN"
[ -n "$OPEN_ROUTER_KEY" ] && export MA_OPENROUTER_API_KEY="$OPEN_ROUTER_KEY"
[ -n "$MODEL" ] && export MA_OPENROUTER_MODEL="$MODEL"

# --- Install deps if needed ------------------------------------------------
if [ ! -d "$ROOT/node_modules" ] && [ "$NO_INSTALL" != "true" ]; then
  echo "→ installing dependencies (first run)…"
  pnpm install --frozen-lockfile
fi

# --- Pick entry point & readiness marker -----------------------------------
if [ "$MODE" = "demo" ]; then
  ENTRY="apps/server/src/demo.ts"
  READY="Managed-Agent demo is running"
else
  ENTRY="apps/server/src/main.ts"
  READY="Managed-Agent listening"
fi

URL="http://${HOST}:${PORT}/"
LOG="$(mktemp -t ma-start.XXXXXX)"
cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG"
}
trap cleanup INT TERM EXIT

echo "→ starting Managed-Agent ($MODE) on $URL (db: $DATABASE)"
node "$ENTRY" >"$LOG" 2>&1 &
SERVER_PID=$!

# --- Wait for readiness ----------------------------------------------------
READY_OK="false"
for _ in $(seq 1 120); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "✗ the server exited during startup:" >&2
    cat "$LOG" >&2
    exit 1
  fi
  if grep -q "$READY" "$LOG" 2>/dev/null; then READY_OK="true"; break; fi
  sleep 0.5
done

# Show the banner (it carries the token and, in demo, the workspace/model).
cat "$LOG"

if [ "$READY_OK" != "true" ]; then
  echo "✗ timed out waiting for the server to listen; see the log above" >&2
  exit 1
fi

# --- Open a browser (unless told not to) -----------------------------------
should_open() {
  case "$OPEN_BROWSER" in
    always) return 0 ;;
    never) return 1 ;;
    *) [ -t 0 ] ;;   # auto: interactive terminal only
  esac
}
if should_open; then
  if command -v open >/dev/null 2>&1; then open "$URL" || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
  fi
fi

echo "→ streaming logs (Ctrl-C to stop)…"
tail -n +1 -f "$LOG" &
TAIL_PID=$!
wait "$SERVER_PID"
kill "$TAIL_PID" 2>/dev/null || true
