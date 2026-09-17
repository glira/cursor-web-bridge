#!/usr/bin/env bash
# Start the local bridge + tunnel (Cloudflare or Ngrok) in the same session.
# Usage: ./start-local.sh
#        PORT=8788 ./start-local.sh
#        TUNNEL_PROVIDER=cloudflare ./start-local.sh
# Ctrl+C stops the bridge and the tunnel.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a
  source .env
  set +a
fi

PORT="${PORT:-8787}"
TUNNEL_PROVIDER="${TUNNEL_PROVIDER:-ngrok}"
NGROK_BIN="${NGROK_BIN:-ngrok}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"
CLOUDFLARE_TUNNEL_NAME="${CLOUDFLARE_TUNNEL_NAME:-cursor-web-bridge}"
BRIDGE_PUBLIC_URL="${BRIDGE_PUBLIC_URL:-}"
CLOUDFLARE_TOKEN_FILE="${CLOUDFLARE_TOKEN_FILE:-}"
if [[ -z "$CLOUDFLARE_TOKEN_FILE" && -n "$CLOUDFLARE_TUNNEL_NAME" ]]; then
  _token_guess="$HOME/.cloudflared/${CLOUDFLARE_TUNNEL_NAME}.token"
  if [[ -f "$_token_guess" ]]; then
    CLOUDFLARE_TOKEN_FILE="$_token_guess"
  fi
fi
unset _token_guess

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm not found in PATH" >&2
  exit 1
fi

case "$TUNNEL_PROVIDER" in
  ngrok)
    if ! command -v "$NGROK_BIN" >/dev/null 2>&1; then
      echo "error: ngrok not found in PATH (install it or set NGROK_BIN)" >&2
      exit 1
    fi
    ;;
  cloudflare)
    if ! command -v "$CLOUDFLARED_BIN" >/dev/null 2>&1; then
      echo "error: cloudflared not found in PATH (install it or set CLOUDFLARED_BIN)" >&2
      exit 1
    fi
    if [[ -z "${CLOUDFLARE_CONFIG:-}" && -z "${CLOUDFLARE_TOKEN_FILE:-}" && -z "${CLOUDFLARE_TUNNEL_NAME:-}" ]]; then
      echo "error: set CLOUDFLARE_TOKEN_FILE, CLOUDFLARE_TUNNEL_NAME, or CLOUDFLARE_CONFIG in .env" >&2
      exit 1
    fi
    ;;
  *)
    echo "error: invalid TUNNEL_PROVIDER (${TUNNEL_PROVIDER}). Use cloudflare or ngrok." >&2
    exit 1
    ;;
esac

if [[ ! -d node_modules ]]; then
  echo "→ npm install"
  npm install
fi

port_holder() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp "sport = :${port}" 2>/dev/null | awk 'NR>1 {print; exit}'
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${port}" -sTCP:LISTEN -n -P 2>/dev/null | awk 'NR==2 {print; exit}'
  fi
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH "sport = :${port}" 2>/dev/null | grep -q .
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${port}" -sTCP:LISTEN -n -P >/dev/null 2>&1
    return $?
  fi
  return 1
}

bridge_healthy() {
  local body
  body="$(curl -sf "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
  [[ "$body" == *'"backend"'* ]]
}

cloudflare_token_running() {
  [[ -n "${CLOUDFLARE_TOKEN_FILE:-}" ]] || return 1
  pgrep -af "cloudflared.*(--token-file|token-file).*${CLOUDFLARE_TUNNEL_NAME}\\.token" 2>/dev/null \
    | grep -v '[p]grep' >/dev/null
}

if port_in_use "$PORT"; then
  if bridge_healthy; then
    echo "notice: bridge already responding at http://127.0.0.1:${PORT} — starting tunnel only (${TUNNEL_PROVIDER})"
  else
    echo "error: port ${PORT} already in use by another process:" >&2
    port_holder "$PORT" >&2 || true
    echo >&2
    echo "Cursor IDE sometimes binds 8787. Use another port, for example:" >&2
    echo "  PORT=8788 ./start-local.sh" >&2
    echo "or change PORT in .env" >&2
    exit 1
  fi
  SKIP_BRIDGE=1
else
  SKIP_BRIDGE=0
fi

BRIDGE_PID=""
TUNNEL_PID=""

cleanup() {
  trap - EXIT INT TERM
  echo
  echo "→ stopping..."
  if [[ -n "$TUNNEL_PID" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
  if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill "$BRIDGE_PID" 2>/dev/null || true
    pkill -P "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [[ "$SKIP_BRIDGE" -eq 0 ]]; then
  echo "→ bridge at http://127.0.0.1:${PORT}"
  # `npm start` (no fs.watch). `tsx watch` dies with EMFILE when inotify
  # instances are already exhausted (Cursor + MCP + desktop apps).
  npm start &
  BRIDGE_PID=$!

  for _ in $(seq 1 60); do
    if bridge_healthy; then
      break
    fi
    if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
      echo "error: bridge exited before becoming ready (port ${PORT}?)" >&2
      exit 1
    fi
    sleep 0.5
  done

  if ! bridge_healthy; then
    echo "error: timeout waiting for /api/health on port ${PORT}" >&2
    exit 1
  fi
fi

start_tunnel() {
  case "$TUNNEL_PROVIDER" in
    cloudflare)
      if [[ -n "${CLOUDFLARE_TOKEN_FILE:-}" ]] && cloudflare_token_running; then
        echo "notice: cloudflared already running with ${CLOUDFLARE_TOKEN_FILE} — not starting another"
        TUNNEL_PID=""
        return 0
      fi
      if [[ -n "${CLOUDFLARE_TOKEN_FILE:-}" ]]; then
        echo "→ cloudflared tunnel run --token-file ${CLOUDFLARE_TOKEN_FILE}"
        "$CLOUDFLARED_BIN" tunnel run --token-file "$CLOUDFLARE_TOKEN_FILE" &
      elif [[ -n "${CLOUDFLARE_CONFIG:-}" ]]; then
        echo "→ cloudflared tunnel --config ${CLOUDFLARE_CONFIG} run"
        "$CLOUDFLARED_BIN" tunnel --config "$CLOUDFLARE_CONFIG" run &
      else
        echo "→ cloudflared tunnel run ${CLOUDFLARE_TUNNEL_NAME}"
        "$CLOUDFLARED_BIN" tunnel run "$CLOUDFLARE_TUNNEL_NAME" &
      fi
      TUNNEL_PID=$!
      sleep 1
      if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
        echo "error: cloudflared exited immediately." >&2
        if [[ ! -f "${HOME}/.cloudflared/cert.pem" && -z "${CLOUDFLARE_TOKEN_FILE:-}" ]]; then
          echo "hint: named tunnel run needs ~/.cloudflared/cert.pem (cloudflared login)," >&2
          echo "      or set CLOUDFLARE_TOKEN_FILE to the remote-managed token." >&2
        fi
        exit 1
      fi
      ;;
    ngrok)
      echo "→ ngrok http ${PORT}"
      "$NGROK_BIN" http "$PORT" &
      TUNNEL_PID=$!
      ;;
  esac
}

start_tunnel

echo
echo "Ready. Local: http://127.0.0.1:${PORT}"
case "$TUNNEL_PROVIDER" in
  cloudflare)
    if [[ -n "$BRIDGE_PUBLIC_URL" ]]; then
      echo "Public URL: ${BRIDGE_PUBLIC_URL}"
    else
      echo "Public URL: ingress hostname (e.g. https://bridge.example.com) — set BRIDGE_PUBLIC_URL in .env to print it here."
    fi
    echo "Ctrl+C to stop the bridge and cloudflared."
    ;;
  ngrok)
    echo "Public URL: ngrok inspector (http://127.0.0.1:4040) or process output."
    echo "Ctrl+C to stop the bridge and ngrok."
    ;;
esac
echo

if [[ -z "$BRIDGE_PID" && -z "$TUNNEL_PID" ]]; then
  trap - EXIT INT TERM
  echo "Already running. Local: http://127.0.0.1:${PORT}"
  if [[ -n "$BRIDGE_PUBLIC_URL" ]]; then
    echo "Public URL: ${BRIDGE_PUBLIC_URL}"
  fi
  echo "This script did not start a new process. Stop the existing node/cloudflared if you need a restart."
  exit 0
fi

if [[ -n "$BRIDGE_PID" && -n "$TUNNEL_PID" ]]; then
  wait "$BRIDGE_PID" "$TUNNEL_PID"
elif [[ -n "$BRIDGE_PID" ]]; then
  wait "$BRIDGE_PID"
else
  wait "$TUNNEL_PID"
fi
