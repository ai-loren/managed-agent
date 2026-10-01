#!/usr/bin/env bash
#
# start.sh — one command to run Managed-Agent locally, with options.
#
# Two modes:
#   demo (default)  console + API + a model (OpenRouter when a key is set,
#                   otherwise an offline echo model) and a seeded Demo
#                   workspace. The best "kick the tyres" experience.
#   prod            the real server (apps/server/src/main.ts). With a model key
#                   it wires the provider too; with none, agent turns that need a
#                   model are refused with MODEL_GATEWAY_UNAVAILABLE.
#
# Examples:
#   ./scripts/start.sh                              # demo, offline echo, :8080, open browser
#   ./scripts/start.sh --no-open                    # demo but don't open a browser
#   ./scripts/start.sh --port 9090 --host 0.0.0.0
#   ./scripts/start.sh --memory                     # ephemeral in-memory database
#   ./scripts/start.sh --database ./data/x.db       # explicit file database
#   ./scripts/start.sh --openrouter-key-file ~/.openrouter   # demo against a real model
#   ./scripts/start.sh --model vendor/model:free
#   ./scripts/start.sh --prod --token-file ~/.ma-token       # production server, fixed admin token
#   ./scripts/start.sh --sandbox-driver container
#   ./scripts/start.sh --dry-run                    # print what would be started, then exit
#
# Logs stream in the foreground; Ctrl-C stops the server.
#
# Secrets are never taken as command-line values: argv is visible to every
# process on the host (`ps`) for as long as the server runs, and lands in shell
# history. They come from a file (--openrouter-key-file, --token-file), the
# environment, or .env.demo.
#
# Environment variables the underlying server reads (set to override anything
# not exposed as a flag): MA_ENCRYPTION_KEYS, MA_CORS_ORIGINS, MA_EGRESS_PROXY,
# MA_VOLUME_ROOT, etc. See apps/server/src/config.ts for the full list.
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ENV_FILE="${MA_START_ENV_FILE:-$ROOT/.env.demo}"

# --- Defaults --------------------------------------------------------------
# Empty means "not given on the command line": the environment, then the env
# file, then the mode default fill it in, in that order.
MODE="demo"
HOST=""
PORT=""
DATABASE=""
LOG_LEVEL=""
SANDBOX_DRIVER=""
OPEN_ROUTER_KEY_FILE=""
MODEL=""
BOOTSTRAP_TOKEN_FILE=""
OPEN_BROWSER="auto"         # auto | always | never
LOAD_DEMO_ENV="true"        # read the env file if present
NO_INSTALL="false"
DRY_RUN="false"

usage() {
  cat <<'USAGE'
start.sh — run Managed-Agent locally

Modes:
  demo (default)  console + API + a model (OpenRouter when a key is set,
                  otherwise an offline echo model) and a seeded Demo workspace.
  prod            the real server; wires the model provider when a key is set.

Examples:
  ./scripts/start.sh                                   demo, echo model, :8080, opens browser
  ./scripts/start.sh --no-open
  ./scripts/start.sh --port 9090 --host 0.0.0.0
  ./scripts/start.sh --memory                          ephemeral in-memory database
  ./scripts/start.sh --database ./data/x.db
  ./scripts/start.sh --openrouter-key-file ~/.openrouter   real model
  ./scripts/start.sh --model vendor/model:free
  ./scripts/start.sh --prod --token-file ~/.ma-token   production server, fixed admin token
  ./scripts/start.sh --sandbox-driver container

Options:
  -m, --mode <demo|prod>        demo = model + seeded workspace (default);
                                prod = the real server
      --prod                    shorthand for --mode prod
      --demo                    shorthand for --mode demo (the default)
  -h, --host <addr>             bind address (default 127.0.0.1; 0.0.0.0 for LAN)
  -p, --port <number>           port (default 8080)
  -d, --database <path>         SQLite file path (prod default ./data/managed-agent.db)
      --memory                  use an ephemeral in-memory database (:memory:)
  -l, --log-level <level>       debug | info | warn | error (default info)
      --sandbox-driver <d>      local | container | k8s (default local)
      --openrouter-key-file <f> a file holding an OpenRouter key: enables a real model
      --model <id>              model id (e.g. x/y:free); in --prod it is catalogued
                                as MA_OPENROUTER_MODELS. Free-only unless
                                MA_OPENROUTER_ALLOW_PAID=true
      --token-file <f>          a file holding the bootstrap admin token (default: a
                                random one, printed once on a fresh database)
      --open                    always open the browser
      --no-open                 never open the browser
      --no-demo-env             do not read .env.demo even if it exists
      --no-install              do not run pnpm install if node_modules is missing
      --dry-run                 print the mode and server environment (secrets
                                masked), then exit without starting anything
      --help                    show this help

Settings are taken from, in order: flags, the environment, .env.demo (MA_*
lines only, read as data; in --prod only the model settings), then defaults.
Unlisted server settings (MA_ENCRYPTION_KEYS, MA_CORS_ORIGINS, MA_EGRESS_PROXY,
MA_VOLUME_ROOT, …) are read straight from the environment; see
apps/server/src/config.ts for the full list.
USAGE
}

refuse_secret_flag() {
  # The value is deliberately not echoed: repeating it would print the secret.
  echo "$1 takes the secret itself on the command line, which every process on this host can read (ps)" >&2
  echo "for as long as the server runs, and which lands in your shell history. Put it in a file and" >&2
  echo "pass $2, or set $3 in the environment or in .env.demo." >&2
  exit 2
}

# --- Parse args ------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift ;;   # pnpm 9 forwards `pnpm start -- …` with the separator intact
    -m|--mode) MODE="${2:?missing value for $1}"; shift 2 ;;
    --prod) MODE="prod"; shift ;;
    --demo) MODE="demo"; shift ;;
    -h|--host) HOST="${2:?missing value for $1}"; shift 2 ;;
    -p|--port) PORT="${2:?missing value for $1}"; shift 2 ;;
    -d|--database) DATABASE="${2:?missing value for $1}"; shift 2 ;;
    --memory) DATABASE=":memory:"; shift ;;
    -l|--log-level) LOG_LEVEL="${2:?missing value for $1}"; shift 2 ;;
    --sandbox-driver) SANDBOX_DRIVER="${2:?missing value for $1}"; shift 2 ;;
    --openrouter-key-file) OPEN_ROUTER_KEY_FILE="${2:?missing value for $1}"; shift 2 ;;
    -k|--openrouter-key) refuse_secret_flag "$1" "--openrouter-key-file <file>" "MA_OPENROUTER_API_KEY" ;;
    --model) MODEL="${2:?missing value for $1}"; shift 2 ;;
    --token-file) BOOTSTRAP_TOKEN_FILE="${2:?missing value for $1}"; shift 2 ;;
    -t|--token) refuse_secret_flag "$1" "--token-file <file>" "MA_BOOTSTRAP_TOKEN" ;;
    --open) OPEN_BROWSER="always"; shift ;;
    --no-open) OPEN_BROWSER="never"; shift ;;
    --no-demo-env) LOAD_DEMO_ENV="false"; shift ;;
    --no-install) NO_INSTALL="true"; shift ;;
    --dry-run) DRY_RUN="true"; shift ;;
    --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; echo "run with --help" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  demo|prod) ;;
  *) echo "invalid --mode '$MODE' (expected demo or prod)" >&2; exit 2 ;;
esac
for f in "$OPEN_ROUTER_KEY_FILE" "$BOOTSTRAP_TOKEN_FILE"; do
  if [ -n "$f" ] && [ ! -r "$f" ]; then echo "cannot read '$f'" >&2; exit 2; fi
done

# --- Read the env file, as data --------------------------------------------
# Never `source`d: that would run whatever shell code it holds and could reset
# this script's own variables. Only MA_* assignments are taken, and only where
# the environment does not already set them. In --prod only the model settings
# are: the file is also where the demo keeps its published admin token and its
# in-memory database, neither of which belongs on a real server.
is_prod_env_key() {
  case "$1" in
    MA_OPENROUTER_API_KEY|MA_OPENROUTER_API_KEY_FILE|MA_OPENROUTER_MODEL|MA_OPENROUTER_MODELS) return 0 ;;
    MA_OPENROUTER_ALLOW_PAID|MA_OPENROUTER_BASE_URL|MA_MODEL_TOOLS) return 0 ;;
    *) return 1 ;;
  esac
}
if [ "$LOAD_DEMO_ENV" = "true" ] && [ -f "$ENV_FILE" ]; then
  echo "→ reading $(basename "$ENV_FILE") (override with --no-demo-env)" >&2
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in ''|'#'*) continue ;; esac
    line="${line#export }"
    key="${line%%=*}"
    [ "$key" = "$line" ] && continue
    value="${line#*=}"
    case "$key" in MA_[A-Z0-9_]*) ;; *) continue ;; esac
    case "$key" in *[!A-Z0-9_]*) continue ;; esac
    if [ "$MODE" = "prod" ] && ! is_prod_env_key "$key"; then continue; fi
    if [ -n "${!key+set}" ]; then continue; fi
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    export "$key=$value"
  done <"$ENV_FILE"
fi

# --- Resolve: flags, then the environment (now including the file), then defaults
HOST="${HOST:-${MA_HOST:-127.0.0.1}}"
PORT="${PORT:-${MA_PORT:-8080}}"
if [ -z "$DATABASE" ]; then
  # Demo defaults to in-memory (no residue); prod to the durable file the server
  # itself would choose.
  if [ "$MODE" = "demo" ]; then DATABASE="${MA_DATABASE:-:memory:}"
  else DATABASE="${MA_DATABASE:-./data/managed-agent.db}"; fi
fi
case "$PORT" in
  ''|*[!0-9]*) echo "invalid --port '$PORT'" >&2; exit 2 ;;
esac

export MA_HOST="$HOST"
export MA_PORT="$PORT"
export MA_DATABASE="$DATABASE"
[ -n "$LOG_LEVEL" ] && export MA_LOG_LEVEL="$LOG_LEVEL"
[ -n "$SANDBOX_DRIVER" ] && export MA_SANDBOX_DRIVER="$SANDBOX_DRIVER"
[ -n "$BOOTSTRAP_TOKEN_FILE" ] && export MA_BOOTSTRAP_TOKEN_FILE="$BOOTSTRAP_TOKEN_FILE"
[ -n "$OPEN_ROUTER_KEY_FILE" ] && export MA_OPENROUTER_API_KEY_FILE="$OPEN_ROUTER_KEY_FILE"
[ -n "$MODEL" ] && export MA_OPENROUTER_MODEL="$MODEL"
# The production entry catalogues models from MA_OPENROUTER_MODELS (the plural
# var); mirror a singular --model / env value into it so `--prod` with a model
# actually wires a provider. The demo entry reads the singular var.
if [ "$MODE" = "prod" ] && [ -z "${MA_OPENROUTER_MODELS:-}" ]; then
  if [ -n "$MODEL" ]; then export MA_OPENROUTER_MODELS="$MODEL"
  elif [ -n "${MA_OPENROUTER_MODEL:-}" ]; then export MA_OPENROUTER_MODELS="$MA_OPENROUTER_MODEL"
  fi
fi

if [ "$MODE" = "demo" ]; then
  ENTRY="apps/server/src/demo.ts"
  READY="Managed-Agent demo is running"
else
  ENTRY="apps/server/src/main.ts"
  READY="Managed-Agent listening"
fi

if [ "$DRY_RUN" = "true" ]; then
  echo "mode=$MODE"
  echo "entry=$ENTRY"
  while IFS='=' read -r key value; do
    case "$key" in
      *_FILE) echo "$key=$value" ;;
      *KEY*|*TOKEN*|*SECRET*) echo "$key=<set>" ;;
      *) echo "$key=$value" ;;
    esac
  done < <(env | grep -E '^MA_[A-Z0-9_]+=' | grep -v '^MA_START_ENV_FILE=' | sort)
  exit 0
fi

# --- Install deps if needed ------------------------------------------------
if [ ! -d "$ROOT/node_modules" ] && [ "$NO_INSTALL" != "true" ]; then
  echo "→ installing dependencies (first run)…"
  pnpm install --frozen-lockfile
fi

URL="http://${HOST}:${PORT}/"
LOG="$(mktemp -t ma-start.XXXXXX)"
cleanup() {
  if [ -n "${TAIL_PID:-}" ]; then kill "$TAIL_PID" 2>/dev/null || true; fi
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

# Show the banner (it carries the token and, in demo, the workspace/model), then
# stream from exactly where it ended, so nothing is printed twice.
PRINTED="$(wc -c <"$LOG" | tr -d ' ')"
head -c "$PRINTED" "$LOG"

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
tail -c "+$((PRINTED + 1))" -f "$LOG" &
TAIL_PID=$!
# `|| status=$?`: under `set -e` a non-zero exit would leave the script before the
# exit code is reported; the EXIT trap stops the tail either way.
status=0
wait "$SERVER_PID" || status=$?
exit "$status"
