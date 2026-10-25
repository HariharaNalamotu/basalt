#!/usr/bin/env bash
# Starts Basalt on this computer and opens the page where you download Claude's connector.
#
#   ./start.sh              build (if needed), start everything, open the Connect Claude page
#   ./start.sh --no-build   start what's already built (faster; skips rebuilding after code changes)
#   ./start.sh --stop       stop Basalt (your apps and data are kept)
#
# Mac: double-click start-mac.command. Windows: double-click start-windows.cmd (it runs this in WSL).
# Set BASALT_WORKSPACE to use another workspace name (default "my-apps"); BASALT_NO_BROWSER=1 to not open the browser.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=basalt.localhost
WORKSPACE="${BASALT_WORKSPACE:-my-apps}"
DEPLOY=hosting/deploy
COMPOSE=(docker compose --project-directory "$DEPLOY" -f "$DEPLOY/docker-compose.yml" -f "$DEPLOY/docker-compose.local.yml")

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

OS=linux
if [[ "$(uname -s)" == Darwin ]]; then OS=mac
elif grep -qi microsoft /proc/version 2>/dev/null; then OS=wsl
fi

docker_hint() {
  case "$OS" in
    mac) echo "Install Docker Desktop for Mac from https://www.docker.com/products/docker-desktop/ and open it once." ;;
    wsl) echo "Install Docker Desktop for Windows, then in Docker Desktop > Settings > Resources > WSL integration, turn it on for this Linux (\"$(. /etc/os-release 2>/dev/null; echo "${NAME:-your distro}")\")." ;;
    *) echo "Install Docker Engine with the Compose plugin: https://docs.docker.com/engine/install/" ;;
  esac
}

# ------------------------------------------------------------------ stop
if [[ "${1:-}" == "--stop" ]]; then
  say "Stopping Basalt (apps and data are kept)…"
  "${COMPOSE[@]}" stop
  echo "Stopped. Run this script again to start."
  exit 0
fi

# ------------------------------------------------------------------ checks
command -v docker >/dev/null 2>&1 || fail "Docker isn't installed. $(docker_hint)"
if ! docker info >/dev/null 2>&1; then
  if [[ "$OS" == mac ]]; then
    say "Starting Docker Desktop…"
    open -a Docker 2>/dev/null || fail "Couldn't open Docker Desktop. $(docker_hint)"
  else
    say "Waiting for Docker to start…"
    [[ "$OS" == wsl ]] && echo "(If Docker Desktop isn't open on Windows, open it now.)"
  fi
  for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || fail "Docker didn't start. $(docker_hint)"
fi
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is missing. $(docker_hint)"
command -v openssl >/dev/null 2>&1 || fail "openssl is missing. Install it (on Ubuntu: sudo apt install openssl) and run this again."

mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
if (( mem > 0 && mem < 7 * 1024 * 1024 * 1024 )); then
  echo "Note: Docker has $(( mem / 1024 / 1024 / 1024 )) GB of memory. 8 GB or more is best (Docker Desktop > Settings > Resources); it still works, one build at a time."
fi

# A Windows checkout can turn the scripts' line endings into ones bash can't run.
for f in "$DEPLOY"/*.sh; do
  if grep -q $'\r' "$f"; then sed -i.bak 's/\r$//' "$f" && rm -f "$f.bak"; fi
done

# ------------------------------------------------------------------ start
running() { [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' basalt-control 2>/dev/null)" == healthy ]]; }
if [[ "${1:-}" == "--no-build" ]] && [[ -f "$DEPLOY/.env" ]]; then
  say "Starting Basalt…"
  "${COMPOSE[@]}" up -d --wait --wait-timeout 300
else
  say "Building and starting Basalt. The first time takes a while (it downloads a few GB)…"
  BASALT_FROM_START=1 "$DEPLOY/setup.sh" "$ROOT" --local
fi
for _ in $(seq 1 60); do running && break; sleep 2; done
running || fail "Basalt didn't come up. See what went wrong with: docker compose -f $DEPLOY/docker-compose.yml logs control"

admin() { docker exec basalt-control node dist/admin.js "$@"; }
WS_ID=$(admin ensure-workspace "$WORKSPACE" | tail -n 1)
[[ "$WS_ID" == ws_* ]] || fail "Couldn't set up the workspace: $WS_ID"
URL=$(admin dashboard-link "$WS_ID" --connect --url-only | tail -n 1)
[[ "$URL" == http* ]] || fail "Couldn't make the dashboard link: $URL"

open_url() {
  case "$OS" in
    mac) open "$1" ;;
    wsl) (cd /mnt/c 2>/dev/null; powershell.exe -NoProfile -Command "Start-Process '$1'" >/dev/null 2>&1) || wslview "$1" 2>/dev/null ;;
    *) xdg-open "$1" >/dev/null 2>&1 ;;
  esac
}
[[ -n "${BASALT_NO_BROWSER:-}" ]] || open_url "$URL" || true

say "Basalt is running."
cat <<EOF
  Connect Claude (opened in your browser; the link works for 24 hours):
    $URL

  Your apps will be at   http://<app>.$ROOT:8080
  Workspace              $WORKSPACE ($WS_ID)
  Stop Basalt            ./start.sh --stop
  Start again later      ./start.sh --no-build

  On the page: download the connector file, put it in your app's folder as .mcp.json,
  and open Claude Code there.
EOF
