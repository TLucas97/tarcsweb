#!/usr/bin/env bash
# Builds the client into the XDG cache dir the service serves (CW_DIST). Shared by install.sh and update.sh.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Same cache as install.sh: launchd never passes XDG_* to the service, so macOS uses the default.
if [ "$(uname -s)" = Darwin ]; then CACHE_ROOT="$HOME/.cache"; else CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}"; fi
DIST="${CW_DIST:-$CACHE_ROOT/tarcsweb/dist}"

mkdir -p "$(dirname "$DIST")"
cd "$REPO"
# Build aside and swap, so the running server never serves a half-written dist.
rm -rf "$DIST.new"
pnpm build --outDir "$DIST.new" --emptyOutDir --logLevel warn
rm -rf "$DIST.old"
[ -d "$DIST" ] && mv "$DIST" "$DIST.old"
mv "$DIST.new" "$DIST"
rm -rf "$DIST.old"
echo "client built into $DIST"
