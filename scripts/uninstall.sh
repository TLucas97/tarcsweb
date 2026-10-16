#!/usr/bin/env bash
# Removes the service, the app entry and, for a release install, the installed releases. Config and cache stay unless --purge.
# Linux and macOS; bash 3.2 compatible.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/tarcsweb"
UNIT="$CONFIG_HOME/systemd/user/tarcsweb.service"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
# shellcheck source=scripts/service-lib.sh
. "$REPO/scripts/service-lib.sh"

remove_linux_service() {
  systemctl --user disable --now tarcsweb.service 2> /dev/null || true
  rm -f "$UNIT" "$DATA_HOME/applications/tarcsweb.desktop" "$DATA_HOME/icons/hicolor/scalable/apps/tarcsweb.svg" "$HOME/.local/bin/tarcsweb"
  systemctl --user daemon-reload || true
  command -v update-desktop-database > /dev/null && update-desktop-database "$DATA_HOME/applications" 2> /dev/null || true
}

remove_mac_service() {
  launchctl bootout "$(launch_target)" 2> /dev/null || true
  rm -f "$LAUNCH_AGENT" "$HOME/.local/bin/tarcsweb"
  rm -rf "$MAC_APP"
}

if [ "${TARCSWEB_NO_SYSTEMD:-0}" != 1 ]; then
  case "$(os_name)" in
    linux) remove_linux_service ;;
    macos) remove_mac_service ;;
  esac
fi

# Only the install this script belongs to; a git clone is never deleted.
if [ -f "$REPO/.tarcsweb-release" ] && [ ! -e "$REPO/.git" ] && [ "$(basename "$(dirname "$REPO")")" = releases ]; then
  INSTALL_HOME="$(dirname "$(dirname "$REPO")")"
  rm -rf "$INSTALL_HOME/releases" "$INSTALL_HOME/current" "$INSTALL_HOME/current.new" "$INSTALL_HOME/.update.lock" "$INSTALL_HOME/.update.lock.d"
  rmdir "$INSTALL_HOME" 2> /dev/null || true
  echo "removed the installed releases in $INSTALL_HOME"
else
  echo "the repo in $REPO was not touched"
fi

if [ "$PURGE" = 1 ]; then
  rm -rf "$CACHE" "$CONFIG_HOME/tarcsweb"
  [ "$(os_name)" != macos ] || rm -rf "$(dirname "$MAC_LOG")"
  echo "removed the service, app entry, cache and config"
else
  echo "removed the service and app entry; kept $CACHE and $CONFIG_HOME/tarcsweb (use --purge to delete them)"
fi
echo "The voice files in ~/.local/share/kokoro-tts were not touched."
