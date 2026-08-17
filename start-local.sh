#!/usr/bin/env bash
# Sobe o bridge local + ngrok na mesma sessão.
# Uso: ./start-local.sh
#      PORT=8788 ./start-local.sh
# Ctrl+C encerra os dois.

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
NGROK_BIN="${NGROK_BIN:-ngrok}"

if ! command -v npm >/dev/null 2>&1; then
  echo "erro: npm não encontrado no PATH" >&2
  exit 1
fi

if ! command -v "$NGROK_BIN" >/dev/null 2>&1; then
  echo "erro: ngrok não encontrado no PATH (instale ou defina NGROK_BIN)" >&2
  exit 1
fi

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
  # fallback: tentativa de bind via bash /dev/tcp não detecta bem; usa curl
  return 1
}

bridge_healthy() {
  local body
  body="$(curl -sf "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
  [[ "$body" == *'"backend"'* ]]
}

if port_in_use "$PORT"; then
  if bridge_healthy; then
    echo "aviso: bridge já responde em http://127.0.0.1:${PORT} — só subindo ngrok"
  else
    echo "erro: porta ${PORT} já em uso por outro processo:" >&2
    port_holder "$PORT" >&2 || true
    echo >&2
    echo "O Cursor IDE às vezes ocupa 8787. Use outra porta, por exemplo:" >&2
    echo "  PORT=8788 ./start-local.sh" >&2
    echo "ou altere PORT no .env" >&2
    exit 1
  fi
  SKIP_BRIDGE=1
else
  SKIP_BRIDGE=0
fi

BRIDGE_PID=""
NGROK_PID=""

cleanup() {
  trap - EXIT INT TERM
  echo
  echo "→ encerrando..."
  if [[ -n "$NGROK_PID" ]] && kill -0 "$NGROK_PID" 2>/dev/null; then
    kill "$NGROK_PID" 2>/dev/null || true
    wait "$NGROK_PID" 2>/dev/null || true
  fi
  if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    # mata o grupo do npm/tsx (filhos inclusos)
    kill "$BRIDGE_PID" 2>/dev/null || true
    pkill -P "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [[ "$SKIP_BRIDGE" -eq 0 ]]; then
  echo "→ bridge em http://127.0.0.1:${PORT}"
  npm run dev &
  BRIDGE_PID=$!

  for _ in $(seq 1 60); do
    if bridge_healthy; then
      break
    fi
    if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
      echo "erro: bridge morreu antes de subir (porta ${PORT}?)" >&2
      exit 1
    fi
    sleep 0.5
  done

  if ! bridge_healthy; then
    echo "erro: timeout esperando /api/health na porta ${PORT}" >&2
    exit 1
  fi
fi

echo "→ ngrok http ${PORT}"
"$NGROK_BIN" http "$PORT" &
NGROK_PID=$!

echo
echo "Pronto. Local: http://127.0.0.1:${PORT}"
echo "URL pública: painel do ngrok (http://127.0.0.1:4040) ou saída do processo."
echo "Ctrl+C para parar bridge + ngrok."
echo

if [[ -n "$BRIDGE_PID" ]]; then
  wait "$BRIDGE_PID" "$NGROK_PID"
else
  wait "$NGROK_PID"
fi
