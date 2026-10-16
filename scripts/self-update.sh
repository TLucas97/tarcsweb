#!/usr/bin/env bash
# Moves a release install to <tag>: download, install, build, boot-check on a spare port, then swap `current` and restart.
# The server starts it outside its own service (systemd-run), so the restart does not kill it. Usage: self-update.sh <tag>
# Progress goes to <cache>/update-state as "step<TAB>tag<TAB>epoch<TAB>message"; output goes to <cache>/update.log.
set -Eeuo pipefail

TAG="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="$(cd "$ROOT/../.." && pwd)"
LOG_DIR="${TARCSWEB_LOG_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tarcsweb}"
LOG="$LOG_DIR/update.log"
STATE="$LOG_DIR/update-state"
PORT="${CW_PORT:-24816}"
NO_SYSTEMD="${TARCSWEB_NO_SYSTEMD:-0}"
# shellcheck source=scripts/release-lib.sh
. "$ROOT/scripts/release-lib.sh"

mkdir -p "$LOG_DIR"
if [ -f "$LOG" ]; then tail -n 500 "$LOG" > "$LOG.tmp" && mv -f "$LOG.tmp" "$LOG"; fi
exec >> "$LOG" 2>&1 < /dev/null

step=starting
dest=""
fresh=0
prev="$(current_tag "$HOME_DIR")"
boot_pid=""

state() {
  step="$1"
  printf '%s\t%s\t%s\t%s\n' "$1" "$TAG" "$(date +%s)" "${2:-}" > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
  printf '[%s] %s %s %s\n' "$(date -Is)" "$1" "$TAG" "${2:-}"
}

stop_boot() {
  [ -n "$boot_pid" ] || return 0
  kill -TERM -- "-$boot_pid" 2> /dev/null || kill -TERM "$boot_pid" 2> /dev/null || true
  wait "$boot_pid" 2> /dev/null || true
  boot_pid=""
}

# Keeps the running version; a release dir made by this run is removed unless `current` points at it.
fail() {
  trap - ERR
  stop_boot
  state failed "$(printf '%s' "$1" | tr '\n\t' '  ' | cut -c1-300)"
  if [ "$fresh" = 1 ] && [ -n "$dest" ] && [ "$(current_tag "$HOME_DIR")" != "$TAG" ]; then rm -rf "$dest"; fi
  exit 1
}
trap 'fail "the $step step stopped unexpectedly (line $LINENO)"' ERR

# GET url until it answers 200, up to $2 half-second tries; gives up early if pid $3 died.
answers() {
  local i
  for i in $(seq 1 "$2"); do
    curl -fsS -o /dev/null --max-time 3 "$1" 2> /dev/null && return 0
    if [ -n "${3:-}" ] && ! kill -0 "$3" 2> /dev/null; then return 1; fi
    sleep 0.5
  done
  return 1
}

[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || { echo "bad tag '$TAG'"; exit 2; }
[ -f "$ROOT/.tarcsweb-release" ] || { echo "$ROOT is not a release install"; exit 2; }
# A second run would fight over the same dirs; it exits without touching the first run's state.
exec 9> "$HOME_DIR/.update.lock"
flock -n 9 || { echo "another update is already running"; exit 3; }

echo "---- update from ${prev:-?} to $TAG"
[ "$prev" != "$TAG" ] || fail "$TAG is already the running version"

state downloading
[ -d "$HOME_DIR/releases/$TAG" ] || fresh=1
dest="$(TARCSWEB_HOME="$HOME_DIR" bash "$ROOT/get.sh" --fetch-only "$TAG" | tail -n 1)" || fail "could not download $TAG"
[ -f "$dest/package.json" ] || fail "the download of $TAG is incomplete"

state installing
(cd "$dest" && pnpm install --frozen-lockfile) || fail "pnpm install failed"
CW_DIST="$dest/dist" bash "$dest/scripts/build-client.sh" || fail "the client build failed"

state checking
spare="$(node -e "const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
(cd "$dest" && CW_PORT="$spare" CW_DIST="$dest/dist" CW_ORIGINS="http://127.0.0.1:$spare" TARCSWEB_UPDATE_CHECK=0 \
  exec setsid node server/index.ts > "$LOG_DIR/update-boot.log" 2>&1) &
boot_pid=$!
if ! answers "http://127.0.0.1:$spare/" 60 "$boot_pid"; then
  cat "$LOG_DIR/update-boot.log" || true
  fail "$TAG did not start in the boot check"
fi
stop_boot
echo "boot check passed on port $spare"

state restarting
swap_current "$HOME_DIR" "$TAG"
if [ "$NO_SYSTEMD" = 1 ]; then
  echo "TARCSWEB_NO_SYSTEMD=1: not restarting the service"
else
  systemctl --user restart tarcsweb.service || true
  if ! answers "http://127.0.0.1:$PORT/" 120; then
    # Roll back to the version that was running, so the app stays usable.
    [ -n "$prev" ] && swap_current "$HOME_DIR" "$prev"
    systemctl --user restart tarcsweb.service || true
    fail "$TAG did not answer after the restart, so ${prev:-the old version} is back"
  fi
fi

state done
prune_releases "$HOME_DIR" "$TAG" "$prev"
echo "---- now on $TAG"
