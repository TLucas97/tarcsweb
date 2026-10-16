#!/usr/bin/env bash
# Git clone: pulls the latest code, refreshes dependencies, rebuilds the client and restarts the service.
# Release install: installs the latest release instead (the app's Settings > Updates does the same).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

if [ -f "$REPO/.tarcsweb-release" ] && [ ! -e "$REPO/.git" ]; then
  exec bash "$REPO/get.sh" "$@"
fi

# shellcheck source=scripts/service-lib.sh
. "$REPO/scripts/service-lib.sh"
git pull --ff-only
pnpm install --frozen-lockfile
"$REPO/scripts/build-client.sh"
service_restart
echo "tarcsweb updated and restarted"
