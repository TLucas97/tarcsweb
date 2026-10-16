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
