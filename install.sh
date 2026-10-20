#!/usr/bin/env bash
# One-script install for tarcsweb: deps, client build, the service and an app entry. Safe to re-run.
# Linux: systemd user service + desktop entry. macOS: launchd agent + ~/Applications/tarcsweb.app.
# Usage: ./install.sh [--yes]     Env: TARCSWEB_PORT (default 24816), TARCSWEB_NTFY_TOPIC (with --yes),
#   TARCSWEB_NO_SYSTEMD=1 (skip the service and app entry on either OS, for tests)
# Run by get.sh inside a release dir, or by hand from a git clone (the developer path). Stays bash 3.2 compatible for macOS.
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
# shellcheck source=scripts/service-lib.sh
. "$REPO/scripts/service-lib.sh"
OS="$(os_name)"
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

# Without the Xcode Command Line Tools, /usr/bin/git and /usr/bin/python3 are stubs that open an install dialog.
mac_dev_tools() { xcode-select -p > /dev/null 2>&1; }

python_usable() {
  command -v python3 > /dev/null || return 1
  [ "$OS" != macos ] || [ "$(command -v python3)" != /usr/bin/python3 ] || mac_dev_tools
}

is_wsl() { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2> /dev/null; }

# WSL leaves systemd off unless /etc/wsl.conf turns it on, so say exactly how.
wsl_systemd_help() {
  cat >&2 << 'EOF'
error: no systemd user session. On WSL, systemd is off until /etc/wsl.conf turns it on:

  1. In this Ubuntu terminal:  printf '\n[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf
  2. In Windows PowerShell:    wsl --shutdown
  3. Open Ubuntu again, check that `ps -p 1 -o comm=` prints systemd, and run the installer again.
EOF
  exit 1
}

check_service_manager() {
  case "$OS" in
    linux)
      if is_wsl && ! systemctl --user show-environment > /dev/null 2>&1; then wsl_systemd_help; fi
      command -v systemctl > /dev/null || die "systemd is required (systemctl not found)"
      systemctl --user show-environment > /dev/null 2>&1 || die "no systemd user session; log in to a desktop session or run from a login shell"
      ;;
    macos)
      launchctl print "$(launch_domain)" > /dev/null 2>&1 || die "no macOS login session for launchd ($(launch_domain)); run this in Terminal while logged in at the Mac, not only over SSH"
      ;;
  esac
}

port_in_use() {
  case "$OS" in
    linux) command -v ss > /dev/null && ss -ltn "sport = :$PORT" | grep -q LISTEN ;;
    macos) lsof -nP -iTCP:"$PORT" -sTCP:LISTEN > /dev/null 2>&1 ;;
  esac
}

[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "TARCSWEB_PORT must be a number from 1024 to 65535"
case "$OS" in
  linux | macos) ;;
  *) die "this installer supports Linux and macOS only" ;;
esac
service_running() { [ "$NO_SYSTEMD" != 1 ] && service_active; }
[ "$NO_SYSTEMD" = 1 ] || check_service_manager

# A clash with something that is not our own service would make the new service fail to bind.
if ! service_running && port_in_use; then
  die "port $PORT is already in use; re-run with TARCSWEB_PORT=<other port>"
fi
echo "installing from $REPO ($MODE)"
if [ "$OS" = macos ] && ! mac_dev_tools; then
  warn "the Xcode Command Line Tools are not installed. tarcsweb runs without them, but voice needs their python3 (or Homebrew's)."
  echo "Install them with:  xcode-select --install"
fi

node_ok() { command -v node > /dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 26 ]; }

# 1. Node
say "Checking Node (26 or newer)"
if ! node_ok; then
  if command -v node > /dev/null; then warn "found Node $(node -v), need 26 or newer"; else warn "Node is not installed"; fi
  if [ "$OS" = macos ]; then
    echo "Get Node 26 with nvm (https://github.com/nvm-sh/nvm), Homebrew or nodejs.org, then re-run this script."
  else
    echo "Get Node 26 with nvm (https://github.com/nvm-sh/nvm) or from your distro, then re-run this script."
  fi
  if ask "Install Node 26 for your user with nvm now?"; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      command -v curl > /dev/null || die "curl is needed to download nvm"
      if [ "$OS" = macos ] && ! mac_dev_tools; then
        # nvm installs with git when it finds one, and the git stub would fail.
        curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | METHOD=script bash
      else
        curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
      fi
    fi
    # nvm.sh reads unset variables, returns non-zero in normal use and does not support pipefail.
    set +euo pipefail
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install 26
    nvm use 26
    set -euo pipefail
  fi
  node_ok || die "Node 26 or newer is required"
fi
SHELL_NODE="$(command -v node)"
# The real binary: a shim or a per-shell symlink (fnm, asdf, mise) would break once the service runs outside this shell.
NODE_BIN="$(node -p 'process.execPath')"
echo "node $(node -v) at $NODE_BIN"
case "$NODE_BIN" in
  */.nvm/* | */nvm/* | */fnm/* | */.fnm/* | */.asdf/* | */mise/* | */.volta/*) NODE_PINNED=1 ;;
  *) NODE_PINNED=0 ;;
esac

# 2. pnpm and dependencies
say "Checking pnpm"
if ! command -v pnpm > /dev/null; then
  warn "pnpm is not installed"
  if command -v corepack > /dev/null && ask "Run 'corepack enable' to get pnpm?"; then
    corepack enable || warn "corepack enable failed (permissions?)"
  fi
  # Node 25+ no longer ships corepack, so npm is the fallback.
  if ! command -v pnpm > /dev/null && command -v npm > /dev/null && ask "Run 'npm install -g pnpm' to get pnpm?"; then
    npm install -g pnpm || warn "npm install -g pnpm failed (permissions?)"
  fi
  command -v pnpm > /dev/null || die "pnpm is required: https://pnpm.io/installation"
fi
say "Installing dependencies"
(cd "$REPO" && pnpm install --frozen-lockfile)

# 3. Agent CLIs: tarcsweb needs Claude Code, Codex, or both
say "Checking the Claude Code and Codex CLIs"
if ! command -v claude > /dev/null; then
  echo "claude: not installed"
else
  # Captured first: under pipefail, `| grep -q` can SIGPIPE claude and look like "not signed in".
  CLAUDE_AUTH="$(claude auth status --json 2> /dev/null || true)"
  case "$CLAUDE_AUTH" in
    *'"loggedIn":true'* | *'"loggedIn": true'*) echo "claude: signed in" ;;
    *) echo "claude: installed, not signed in (sign in with: claude auth login)" ;;
  esac
fi
if command -v codex > /dev/null; then echo "codex: installed (sign in from Settings > Account)"; else echo "codex: not installed"; fi
if ! command -v claude > /dev/null && ! command -v codex > /dev/null; then
  warn "neither the 'claude' nor the 'codex' CLI is on PATH; install at least one"
  echo "Claude Code:  curl -fsSL https://claude.ai/install.sh | bash"
  echo "Codex:        npm install -g @openai/codex"
fi
# Optional: concept drawings in the explain panel are rasterized with rsvg-convert.
if ! command -v rsvg-convert > /dev/null; then
  if [ "$OS" = macos ]; then
    echo "rsvg-convert: not installed, concept drawings need it (optional): brew install librsvg"
  else
    echo "rsvg-convert: not installed, concept drawings need it (optional): librsvg2-bin (Debian/Ubuntu) or librsvg (Arch/Fedora)"
  fi
fi

# 4. Client build
say "Building the client into $DIST"
CW_DIST="$DIST" "$REPO/scripts/build-client.sh"

# 5. Optional: voice (Kokoro TTS)
install_voice() {
  local py_hint=""
  [ "$OS" != macos ] || py_hint=" (brew install python gets one)"
  if ! python_usable; then
    if [ "$OS" = macos ]; then
      warn "python3 needs the Xcode Command Line Tools (xcode-select --install) or Homebrew (brew install python), skipping voice"
    else
      warn "python3 not found, skipping voice"
    fi
    return 0
  fi
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { warn "voice needs Python 3.10 or newer$py_hint, skipping"; return 0; }
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
  say "TARCSWEB_NO_SYSTEMD=1: skipping the service and the app entry"
  [ "$MODE" != release ] || prune_releases "$INSTALL_HOME" "$TAG" "$PREV"
  echo "Run it by hand: cd \"$RUN_DIR\" && CW_PORT=$PORT CW_DIST=\"$RUN_DIST\" CW_ORIGINS=http://localhost:$PORT node server/index.ts"
  exit 0
fi

# 8. The service. The in-app updater runs pnpm with this PATH, and pnpm's own installer puts it outside node's dir.
SERVICE_PATH="$(dirname "$NODE_BIN")"
# The shell's own node dir (a shim dir, say) stays reachable for tools found through it today.
[ "$(dirname "$SHELL_NODE")" = "$(dirname "$NODE_BIN")" ] || SERVICE_PATH="$SERVICE_PATH:$(dirname "$SHELL_NODE")"
if CLAUDE_BIN="$(command -v claude)"; then SERVICE_PATH="$SERVICE_PATH:$(dirname "$CLAUDE_BIN")"; fi
if CODEX_BIN="$(command -v codex)"; then SERVICE_PATH="$SERVICE_PATH:$(dirname "$CODEX_BIN")"; fi
if PNPM_BIN="$(command -v pnpm)"; then SERVICE_PATH="$SERVICE_PATH:$(dirname "$PNPM_BIN")"; fi
if [ "$OS" = macos ]; then
  # Homebrew comes before /usr/bin so a brew python3 wins over the 3.9 from the Command Line Tools.
  SERVICE_PATH="$SERVICE_PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
else
  SERVICE_PATH="$SERVICE_PATH:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
fi

install_systemd_unit() {
  say "Writing the systemd user service"
  # systemd expands % in unit files, so a literal one is doubled.
  esc() { printf '%s' "${1//\%/%%}"; }
  mkdir -p "$UNIT_DIR" "$CACHE"
  cat > "$UNIT_DIR/tarcsweb.service" << EOF
[Unit]
Description=tarcsweb, a web UI for Claude Code and Codex

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
}

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# KeepAlive with SuccessfulExit=false restarts on a crash only, like systemd's Restart=on-failure.
install_launch_agent() {
  say "Writing the launchd agent $SERVICE_LABEL"
  mkdir -p "$(dirname "$LAUNCH_AGENT")" "$(dirname "$MAC_LOG")" "$CACHE"
  cat > "$LAUNCH_AGENT" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE_BIN")</string>
    <string>server/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml "$RUN_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml "$SERVICE_PATH")</string>
    <key>LANG</key>
    <string>$(xml "${LANG:-en_US.UTF-8}")</string>
    <key>CW_PORT</key>
    <string>$PORT</string>
    <key>CW_DIST</key>
    <string>$(xml "$RUN_DIST")</string>
    <key>CW_ORIGINS</key>
    <string>http://localhost:$PORT,http://127.0.0.1:$PORT</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>3</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$(xml "$MAC_LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$MAC_LOG")</string>
</dict>
</plist>
EOF
  plutil -lint "$LAUNCH_AGENT" > /dev/null || die "$LAUNCH_AGENT is not a valid plist"
  # The log has no rotation, so a long one is cut at each install.
  if [ -f "$MAC_LOG" ] && [ "$(wc -c < "$MAC_LOG")" -gt 5000000 ]; then
    tail -n 2000 "$MAC_LOG" > "$MAC_LOG.tmp" && mv -f "$MAC_LOG.tmp" "$MAC_LOG"
  fi
  launch_agent_load || die "launchctl could not load $LAUNCH_AGENT"
}

install_linux_entry() {
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
Comment=Web UI for Claude Code and Codex
Exec=$LAUNCHER
Icon=$ICON
Terminal=false
Categories=Development;
EOF
  command -v update-desktop-database > /dev/null && update-desktop-database "$APP_DIR" 2> /dev/null || true
}

# Single-quotes a value for a generated sh script.
sh_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# The command, plus a script-only app bundle so Spotlight and Launchpad find it. No icon: macOS wants .icns.
install_mac_entry() {
  say "Writing the tarcsweb command and $MAC_APP"
  mkdir -p "$(dirname "$LAUNCHER")"
  {
    printf '#!/bin/sh\n# Written by tarcsweb install.sh: starts the launchd agent if needed and opens the app.\n'
    printf 'URL=%s\nLABEL=%s\nPLIST=%s\nLOG=%s\n' "$(sh_quote "$URL")" "$(sh_quote "$SERVICE_LABEL")" "$(sh_quote "$LAUNCH_AGENT")" "$(sh_quote "$MAC_LOG")"
    cat << 'EOF'
DOMAIN="gui/$(id -u)"
launchctl print "$DOMAIN/$LABEL" > /dev/null 2>&1 || launchctl bootstrap "$DOMAIN" "$PLIST" || exit 1
# Starts a stopped agent; a running one is left alone, and the wait below is the real check.
launchctl kickstart "$DOMAIN/$LABEL" > /dev/null 2>&1
i=0
until curl -fs -o /dev/null --max-time 2 "$URL"; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || { echo "tarcsweb did not answer on $URL; see $LOG" >&2; exit 1; }
  sleep 1
done
echo "tarcsweb is running at $URL"
exec open "$URL"
EOF
  } > "$LAUNCHER"
  chmod 755 "$LAUNCHER"
  rm -rf "$MAC_APP"
  mkdir -p "$MAC_APP/Contents/MacOS"
  cat > "$MAC_APP/Contents/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>tarcsweb</string>
  <key>CFBundleIdentifier</key>
  <string>$SERVICE_LABEL.launcher</string>
  <key>CFBundleName</key>
  <string>tarcsweb</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
EOF
  printf '#!/bin/sh\nexec %s\n' "$(sh_quote "$LAUNCHER")" > "$MAC_APP/Contents/MacOS/tarcsweb"
  chmod 755 "$MAC_APP/Contents/MacOS/tarcsweb"
}

if [ "$OS" = macos ]; then
  install_launch_agent
  install_mac_entry
else
  install_systemd_unit
  install_linux_entry
fi

# 9. Wait for the server
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
  service_log_tail || true
  # A release that does not start gives the port back to the one that ran before it.
  if [ "$MODE" = release ] && [ -n "$PREV" ] && [ "$PREV" != "$TAG" ] && [ -d "$INSTALL_HOME/releases/$PREV" ]; then
    warn "going back to $PREV"
    swap_current "$INSTALL_HOME" "$PREV"
    service_restart || true
  fi
  exit 1
fi
[ "$MODE" != release ] || prune_releases "$INSTALL_HOME" "$TAG" "$PREV"

if [ "$MODE" = release ]; then
  UPDATE_HINT="Settings > Updates in the app, or run the install command again"
else
  UPDATE_HINT="$REPO/scripts/update.sh"
fi
if [ "$OS" = macos ]; then
  cat << EOF

tarcsweb${TAG:+ $TAG} is running.
  URL:      $URL
  Open:     run tarcsweb, or open tarcsweb from ~/Applications (Spotlight finds it)
  Restart:  launchctl kickstart -k gui/\$(id -u)/$SERVICE_LABEL
  Logs:     tail -f "$MAC_LOG"
  Update:   $UPDATE_HINT
  Remove:   $RUN_DIR/scripts/uninstall.sh
It starts when you log in to the Mac.
EOF
else
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
fi
[ "$NODE_PINNED" = 0 ] || warn "the service is pinned to $NODE_BIN; re-run the installer after you switch or remove this Node version."
case ":$PATH:" in
  *":$(dirname "$LAUNCHER"):"*) ;;
  *)
    warn "$(dirname "$LAUNCHER") is not on your PATH, so the tarcsweb command needs its full path: $LAUNCHER"
    # zsh is the default macOS shell and reads ~/.zprofile at login.
    [ "$OS" != macos ] || echo "To fix it, run:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zprofile"
    ;;
esac

# Opens the app in the default browser when there is a desktop session; otherwise the URL above is enough.
if [ "$OS" = macos ]; then
  [ -n "${SSH_CONNECTION:-}" ] || open "$URL" > /dev/null 2>&1 || true
elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open > /dev/null; then
  xdg-open "$URL" > /dev/null 2>&1 || true
fi
