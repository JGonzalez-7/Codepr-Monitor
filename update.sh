#!/usr/bin/env bash
#
# Rebuild the CodePR-Monitor app image from the current working tree, restart
# the container, and wait for it to report healthy.
#
# The image is a snapshot: the Dockerfile COPYs app/ in at build time, and the
# compose file mounts nothing, so edits to Python, templates, or static files do
# not reach a running container until the image is rebuilt. Run this after
# changing anything under app/ or requirements.txt.
#
#   ./update.sh          rebuild and restart the app service
#   ./update.sh --all    rebuild and recreate every service (docker-compose.yml
#                        changes, or when db / uptime-kuma need recreating)
#
# Git is not involved. This builds from the files on disk, committed or not.

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

SERVICES=(app)
case "${1:-}" in
  "")      ;;
  --all)   SERVICES=() ;;
  -h|--help)
    sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  *)
    echo "usage: $(basename "$0") [--all]" >&2
    exit 2 ;;
esac

# Bash 4.3 and older choke on an empty array under `set -u`.
expand_services() { printf '%s\n' "${SERVICES[@]+"${SERVICES[@]}"}"; }
readarray -t SERVICE_ARGS < <(expand_services)

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose is not available. Start Docker Desktop (and enable its" >&2
  echo "WSL integration) before running this." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "No .env in $(pwd)." >&2
  echo "Copy .env.example to .env and set SECRET_KEY and the SEED_* passwords first." >&2
  exit 1
fi

echo "-> Rebuilding image from $(pwd)"
"${COMPOSE[@]}" build ${SERVICE_ARGS[@]+"${SERVICE_ARGS[@]}"}

echo "-> Recreating container"
"${COMPOSE[@]}" up -d ${SERVICE_ARGS[@]+"${SERVICE_ARGS[@]}"}

# Ask compose where the app actually landed rather than assuming 8090, so a
# changed port mapping does not turn into a false "unhealthy" report.
PORT="$("${COMPOSE[@]}" port app 8000 2>/dev/null | sed 's/.*://')"
PORT="${PORT:-8090}"
HEALTH="http://localhost:${PORT}/healthz"

echo -n "-> Waiting for ${HEALTH} "
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "$HEALTH" >/dev/null 2>&1; then
    echo ""
    echo ""
    echo "CodePR-Monitor updated and healthy at http://localhost:${PORT}"
    echo ""
    echo "Hard-refresh the browser (Ctrl+Shift+R) to pick up changed CSS."
    echo "Note: monitored page URLs live in the database, not the image. Seeding"
    echo "only runs for pages that do not exist yet, so change them under"
    echo "Pages (/admin/sites) — no rebuild will update them."
    exit 0
  fi
  echo -n "."
  sleep 2
done

echo ""
echo ""
echo "The container did not become healthy within 120s. Recent logs:" >&2
echo "" >&2
"${COMPOSE[@]}" logs --tail 40 app >&2
exit 1
