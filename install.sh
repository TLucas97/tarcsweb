#!/usr/bin/env bash
# One-script install for tarcsweb: deps, client build, systemd user service, desktop entry. Safe to re-run.
# Usage: ./install.sh [--yes]     Env: TARCSWEB_PORT (default 24816), TARCSWEB_NTFY_TOPIC (with --yes),
#   TARCSWEB_NO_SYSTEMD=1 (skip the service and desktop entry, for tests)
# Run by get.sh inside a release dir, or by hand from a git clone (the developer path).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${TARCSWEB_PORT:-24816}"
NO_SYSTEMD="${TARCSWEB_NO_SYSTEMD:-0}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/tarcsweb"
# A release install (get.sh) builds into its own dir and the service runs from <home>/current, so switching versions is a symlink swap.
if [ -f "$REPO/.tarcsweb-release" ] && [ ! -e "$REPO/.git" ] && [ "$(basename "$(dirname "$REPO")")" = releases ]; then
  MODE=release
  INSTALL_HOME="$(cd "$REPO/../.." && pwd)"
  TAG="$(basename "$REPO")"
  DIST="$REPO/dist"
  RUN_DIR="$INSTALL_HOME/current"
  RUN_DIST="$RUN_DIR/dist"
  # shellcheck source=scripts/release-lib.sh
  . "$REPO/scripts/release-lib.sh"
else
  MODE=source
  DIST="$CACHE/dist"
  RUN_DIR="$REPO"
  RUN_DIST="$DIST"
fi
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
UNIT_DIR="$CONFIG_HOME/systemd/user"
APP_DIR="$DATA_HOME/applications"
ICON="$DATA_HOME/icons/hicolor/scalable/apps/tarcsweb.svg"
LAUNCHER="$HOME/.local/bin/tarcsweb"
APP_CONFIG="$CONFIG_HOME/tarcsweb/config.json"
KOKORO="$HOME/.local/share/kokoro-tts"
NVM_VERSION="v0.40.3"
KOKORO_BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
URL="http://localhost:$PORT/"
YES=0
[ "${1:-}" = "--yes" ] || [ "${1:-}" = "-y" ] && YES=1

say() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# y/N prompt; reads the terminal even when piped, and answers no when there is none.
ask() {
  if [ "$YES" = 1 ]; then return 0; fi
  local reply=""
  # The device can exist without a terminal behind it (setsid, cron), so try opening it first.
  if (: < /dev/tty) 2> /dev/null; then
    read -r -p "$1 [y/N] " reply < /dev/tty || true
  fi
  case "$reply" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "TARCSWEB_PORT must be a number from 1024 to 65535"
[ "$(uname -s)" = Linux ] || die "this installer supports Linux only"
service_active() { [ "$NO_SYSTEMD" != 1 ] && systemctl --user is-active --quiet tarcsweb.service; }
if [ "$NO_SYSTEMD" != 1 ]; then
  command -v systemctl > /dev/null || die "systemd is required (systemctl not found)"
  systemctl --user show-environment > /dev/null 2>&1 || die "no systemd user session; log in to a desktop session or run from a login shell"
fi

# A clash with something that is not our own service would make the new service fail to bind.
if ! service_active && command -v ss > /dev/null && ss -ltn "sport = :$PORT" | grep -q LISTEN; then
  die "port $PORT is already in use; re-run with TARCSWEB_PORT=<other port>"
fi
echo "installing from $REPO ($MODE)"

node_ok() { command -v node > /dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 26 ]; }

# 1. Node
say "Checking Node (26 or newer)"
if ! node_ok; then
  if command -v node > /dev/null; then warn "found Node $(node -v), need 26 or newer"; else warn "Node is not installed"; fi
  echo "Get Node 26 with nvm (https://github.com/nvm-sh/nvm) or from your distro, then re-run this script."
  if ask "Install Node 26 for your user with nvm now?"; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      command -v curl > /dev/null || die "curl is needed to download nvm"
      curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
    fi
    # nvm.sh reads unset variables and returns non-zero in normal use.
    set +eu
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install 26
    nvm use 26
    set -eu
  fi
  node_ok || die "Node 26 or newer is required"
fi
NODE_BIN="$(command -v node)"
echo "node $(node -v) at $NODE_BIN"

# 2. pnpm and dependencies
say "Checking pnpm"
if ! command -v pnpm > /dev/null; then
  warn "pnpm is not installed"
  if command -v corepack > /dev/null && ask "Run 'corepack enable' to get pnpm?"; then
    corepack enable || die "corepack enable failed (permissions?). Try: npm install -g pnpm, or see https://pnpm.io/installation"
  fi
  command -v pnpm > /dev/null || die "pnpm is required: https://pnpm.io/installation"
fi
say "Installing dependencies"
(cd "$REPO" && pnpm install --frozen-lockfile)

# 3. Claude Code CLI and login
say "Checking the Claude Code CLI"
if ! command -v claude > /dev/null; then
  warn "the 'claude' CLI is not on PATH"
  echo "Install it (https://claude.ai/install.sh):  curl -fsSL https://claude.ai/install.sh | bash"
  echo "Then sign in with:  claude auth login"
elif ! claude auth status --json 2> /dev/null | grep -q '"loggedIn": *true'; then
  warn "Claude Code is not signed in"
  echo "Sign in with:  claude auth login"
else
  echo "claude is signed in"
fi

# 4. Client build
say "Building the client into $DIST"
CW_DIST="$DIST" "$REPO/scripts/build-client.sh"

# 5. Optional: voice (Kokoro TTS)
install_voice() {
  command -v python3 > /dev/null || { warn "python3 not found, skipping voice"; return 0; }
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { warn "voice needs Python 3.10 or newer, skipping"; return 0; }
  mkdir -p "$KOKORO"
  if [ ! -x "$KOKORO/venv/bin/python" ]; then
    python3 -m venv "$KOKORO/venv" || { warn "python3 -m venv failed (on Debian/Ubuntu install python3-venv), skipping voice"; return 0; }
  fi
  # voice.py works around a speed-dtype quirk of this exact version.
  "$KOKORO/venv/bin/python" -m pip install --quiet "kokoro-onnx==0.4.7" || { warn "pip install kokoro-onnx failed, skipping voice"; return 0; }
  local file
  for file in kokoro-v1.0.onnx voices-v1.0.bin; do
    if [ -s "$KOKORO/$file" ]; then echo "$file already present"; continue; fi
    command -v curl > /dev/null || { warn "curl not found, cannot download $file"; return 0; }
    echo "Downloading $file"
    curl -fL --retry 3 -C - -o "$KOKORO/$file.part" "$KOKORO_BASE/$file" || { warn "download of $file failed; re-run to resume"; return 0; }
    mv "$KOKORO/$file.part" "$KOKORO/$file"
  done
  echo "voice ready in $KOKORO"
}
say "Optional: spoken recaps (Kokoro TTS)"
if ask "Install voice? Downloads about 350 MB of model files and a Python venv"; then install_voice; fi

# 6. Optional: ntfy push topic
set_ntfy() {
  local topic="$1"
  mkdir -p "$(dirname "$APP_CONFIG")"
  # Merge into the existing file; an unreadable file is left alone.
  NTFY_TOPIC="$topic" NTFY_SERVER="${TARCSWEB_NTFY_SERVER:-https://ntfy.sh}" node - "$APP_CONFIG" << 'JS' || { warn "could not update $APP_CONFIG"; return 0; }
const fs = require('node:fs');
const file = process.argv[2];
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') { console.error(`${file} is not valid JSON, not touching it`); process.exit(1); }
}
if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { console.error(`${file} is not a JSON object, not touching it`); process.exit(1); }
cfg.ntfy = { ...(cfg.ntfy && typeof cfg.ntfy === 'object' ? cfg.ntfy : {}), topic: process.env.NTFY_TOPIC, server: process.env.NTFY_SERVER };
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
JS
  chmod 600 "$APP_CONFIG"
  echo "ntfy topic saved in $APP_CONFIG"
}
say "Optional: phone notifications (ntfy)"
if [ "$YES" = 1 ]; then
  [ -z "${TARCSWEB_NTFY_TOPIC:-}" ] || set_ntfy "$TARCSWEB_NTFY_TOPIC"
elif ask "Set up an ntfy topic for push notifications?"; then
  topic=""
  [ -r /dev/tty ] && read -r -p "Topic (treat it like a password): " topic < /dev/tty || true
  if [ -n "$topic" ]; then set_ntfy "$topic"; else warn "no topic given, skipping"; fi
fi

# 7. Release installs: point `current` at this release
PREV=""
if [ "$MODE" = release ]; then
  PREV="$(current_tag "$INSTALL_HOME")"
  say "Switching $INSTALL_HOME/current to $TAG"
  swap_current "$INSTALL_HOME" "$TAG"
fi

if [ "$NO_SYSTEMD" = 1 ]; then
  say "TARCSWEB_NO_SYSTEMD=1: skipping the service and the desktop entry"
  [ "$MODE" != release ] || prune_releases "$INSTALL_HOME" "$TAG" "$PREV"
  echo "Run it by hand: cd \"$RUN_DIR\" && CW_PORT=$PORT CW_DIST=\"$RUN_DIST\" CW_ORIGINS=http://localhost:$PORT node server/index.ts"
  exit 0
fi

# 8. systemd user service
say "Writing the systemd user service"
# systemd expands % in unit files, so a literal one is doubled.
esc() { printf '%s' "${1//\%/%%}"; }
SERVICE_PATH="$(dirname "$NODE_BIN")"
if CLAUDE_BIN="$(command -v claude)"; then SERVICE_PATH="$SERVICE_PATH:$(dirname "$CLAUDE_BIN")"; fi
# The in-app updater runs pnpm with this PATH, and pnpm's own installer puts it outside node's dir.
if PNPM_BIN="$(command -v pnpm)"; then SERVICE_PATH="$SERVICE_PATH:$(dirname "$PNPM_BIN")"; fi
SERVICE_PATH="$SERVICE_PATH:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
mkdir -p "$UNIT_DIR" "$CACHE"
cat > "$UNIT_DIR/tarcsweb.service" << EOF
[Unit]
Description=tarcsweb, a web UI for Claude Code

[Service]
WorkingDirectory=$(esc "$RUN_DIR")
ExecStart="$(esc "$NODE_BIN")" server/index.ts
Environment="PATH=$(esc "$SERVICE_PATH")"
Environment="CW_PORT=$PORT"
Environment="CW_DIST=$(esc "$RUN_DIST")"
Environment="CW_ORIGINS=http://localhost:$PORT,http://127.0.0.1:$PORT"
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable tarcsweb.service
systemctl --user restart tarcsweb.service

# 9. The `tarcsweb` command and the desktop entry
say "Writing the tarcsweb command and the desktop entry"
mkdir -p "$(dirname "$LAUNCHER")" "$APP_DIR" "$(dirname "$ICON")"
{
  printf '#!/bin/sh\n# Written by tarcsweb install.sh: starts the service if needed and opens the app.\nURL="%s"\n' "$URL"
  cat << 'EOF'
systemctl --user start tarcsweb.service || exit 1
i=0
until curl -fs -o /dev/null --max-time 2 "$URL"; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || { echo "tarcsweb did not answer on $URL; see journalctl --user -u tarcsweb -n 20" >&2; exit 1; }
  sleep 1
done
echo "tarcsweb is running at $URL"
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open > /dev/null; then
  exec xdg-open "$URL" > /dev/null 2>&1
fi
EOF
} > "$LAUNCHER"
chmod 755 "$LAUNCHER"
cp "$REPO/assets/tarcsweb.svg" "$ICON"
cat > "$APP_DIR/tarcsweb.desktop" << EOF
[Desktop Entry]
Type=Application
Name=tarcsweb
Comment=Web UI for Claude Code
Exec=$LAUNCHER
Icon=$ICON
Terminal=false
Categories=Development;
EOF
command -v update-desktop-database > /dev/null && update-desktop-database "$APP_DIR" 2> /dev/null || true

# 10. Wait for the server
wait_ready() {
  local _
  for _ in $(seq 1 30); do
    if node -e "fetch(process.argv[1]).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" "http://127.0.0.1:$PORT/" 2> /dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
say "Waiting for the server"
if ! wait_ready; then
  warn "the server did not answer on port $PORT; recent log:"
  journalctl --user -u tarcsweb.service -n 20 --no-pager || true
  # A release that does not start gives the port back to the one that ran before it.
  if [ "$MODE" = release ] && [ -n "$PREV" ] && [ "$PREV" != "$TAG" ] && [ -d "$INSTALL_HOME/releases/$PREV" ]; then
    warn "going back to $PREV"
    swap_current "$INSTALL_HOME" "$PREV"
    systemctl --user restart tarcsweb.service || true
  fi
  exit 1
fi
[ "$MODE" != release ] || prune_releases "$INSTALL_HOME" "$TAG" "$PREV"

if [ "$MODE" = release ]; then
  UPDATE_HINT="Settings > Updates in the app, or run the install command again"
else
  UPDATE_HINT="$REPO/scripts/update.sh"
fi
cat << EOF

tarcsweb${TAG:+ $TAG} is running.
  URL:      $URL
  Open:     run tarcsweb, or pick tarcsweb in your app menu
  Service:  systemctl --user status tarcsweb
  Logs:     journalctl --user -u tarcsweb -f
  Update:   $UPDATE_HINT
  Remove:   $RUN_DIR/scripts/uninstall.sh
It starts at login. To keep it running after you log out: loginctl enable-linger \$USER
EOF
case ":$PATH:" in
  *":$(dirname "$LAUNCHER"):"*) ;;
  *) warn "$(dirname "$LAUNCHER") is not on your PATH, so the tarcsweb command needs its full path: $LAUNCHER" ;;
esac

# Opens the app in the default browser when there is a desktop session; otherwise the URL above is enough.
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open > /dev/null; then
  xdg-open "$URL" > /dev/null 2>&1 || true
fi
