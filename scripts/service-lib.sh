# Sourced by install.sh, self-update.sh, update.sh and uninstall.sh: the tarcsweb service on each OS.
# Linux runs it as the systemd user unit tarcsweb.service, macOS as a launchd agent in the GUI login domain.

SERVICE_LABEL="io.github.tlucas97.tarcsweb"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
MAC_LOG="$HOME/Library/Logs/tarcsweb/tarcsweb.log"
# shellcheck disable=SC2034 # used by install.sh and uninstall.sh
MAC_APP="$HOME/Applications/tarcsweb.app"

# linux, macos or other. Never fails, so callers under an ERR trap can branch on it safely.
os_name() {
  case "$(uname -s)" in
    Linux) echo linux ;;
    Darwin) echo macos ;;
    *) echo other ;;
  esac
}

is_wsl() { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2> /dev/null; }

# Windows stops a WSL distro once no process started from Windows is left in it, systemd services included.
# A hidden script in the Windows Startup folder keeps one such process, named so it can be found, alive at login.
WSL_KEEPALIVE_NAME="tarcsweb-wsl-keepalive"

# cmd.exe is looked up by path too: [interop] appendWindowsPath=false drops the Windows dirs from PATH.
wsl_cmd() {
  local cmd
  cmd="$(command -v cmd.exe 2> /dev/null || true)"
  [ -n "$cmd" ] || cmd=/mnt/c/Windows/System32/cmd.exe
  [ -x "$cmd" ] || return 1
  # cmd.exe warns on stderr about the Linux working directory, and ends its lines with CRLF.
  "$cmd" /c "$@" 2> /dev/null | tr -d '\r'
}

# The Windows user can differ from the Linux one, so the folder comes from %APPDATA%, never from $USER.
wsl_keepalive_file() {
  local appdata dir
  appdata="$(wsl_cmd echo %APPDATA%)" || return 1
  case "$appdata" in '' | *%*) return 1 ;; esac
  appdata="$(wslpath -u "$appdata" 2> /dev/null)" || return 1
  dir="$appdata/Microsoft/Windows/Start Menu/Programs/Startup"
  [ -d "$dir" ] || return 1
  printf '%s/%s.vbs' "$dir" "$WSL_KEEPALIVE_NAME"
}

wsl_keepalive_running() { pgrep -f "^$WSL_KEEPALIVE_NAME " > /dev/null 2>&1; }

# Runs the Startup script now, so the current Windows login is covered too.
wsl_keepalive_start() {
  wsl_keepalive_running && return 0
  wsl_cmd wscript.exe "$(wslpath -w "$1")" > /dev/null || return 1
  local _
  for _ in 1 2 3 4 5; do
    wsl_keepalive_running && return 0
    sleep 1
  done
  return 1
}

wsl_keepalive_stop() { pkill -f "^$WSL_KEEPALIVE_NAME " 2> /dev/null || true; }

launch_domain() { printf 'gui/%s' "$(id -u)"; }
launch_target() { printf '%s/%s' "$(launch_domain)" "$SERVICE_LABEL"; }

# The output is captured first: `launchctl print | grep -q` fails under pipefail when grep stops reading early.
service_active() {
  case "$(os_name)" in
    linux) systemctl --user is-active --quiet tarcsweb.service ;;
    macos)
      case "$(launchctl print "$(launch_target)" 2> /dev/null)" in
        *"state = running"*) return 0 ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

service_restart() {
  case "$(os_name)" in
    linux) systemctl --user restart tarcsweb.service ;;
    macos) launchctl kickstart -k "$(launch_target)" ;;
    *) return 1 ;;
  esac
}

# (Re)loads the agent from its plist. bootout returns before the old job is gone, so bootstrap is retried.
launch_agent_load() {
  local _
  launchctl bootout "$(launch_target)" 2> /dev/null || true
  launchctl enable "$(launch_target)" 2> /dev/null || true
  for _ in 1 2 3 4 5; do
    launchctl bootstrap "$(launch_domain)" "$LAUNCH_AGENT" 2> /dev/null && return 0
    sleep 1
  done
  launchctl bootstrap "$(launch_domain)" "$LAUNCH_AGENT"
}

# The last lines the service wrote, for an install or update that did not come up.
service_log_tail() {
  case "$(os_name)" in
    linux) journalctl --user -u tarcsweb.service -n 20 --no-pager ;;
    macos) tail -n 20 "$MAC_LOG" ;;
    *) return 1 ;;
  esac
}
