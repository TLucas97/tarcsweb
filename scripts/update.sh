#!/usr/bin/env bash
# Git clone: pulls the latest code, refreshes dependencies, rebuilds the client and restarts the service.
# Release install: installs the latest release instead (the app's Settings > Updates does the same).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

if [ -f "$REPO/.tarcsweb-release" ] && [ ! -e "$REPO/.git" ]; then
  exec bash "$REPO/get.sh" "$@"
fi

git pull --ff-only
pnpm install --frozen-lockfile
"$REPO/scripts/build-client.sh"
systemctl --user restart tarcsweb.service
echo "tarcsweb updated and restarted"
