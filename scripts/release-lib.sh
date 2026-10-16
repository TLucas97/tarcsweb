# Sourced by install.sh and self-update.sh: the `current` symlink of a release install and old release cleanup. Bash 3.2 and BSD safe.
# Layout: <home>/releases/<tag>/ (source, node_modules, dist) and <home>/current -> releases/<tag>.

# The tag `current` points at, or nothing.
current_tag() {
  local t
  t="$(readlink "$1/current" 2> /dev/null || true)"
  printf '%s' "${t##*/}"
}

# Renaming a new link over the old one is atomic, so `current` is never missing.
# macOS mv spells GNU's -T as -h; /bin/mv skips a GNU coreutils mv that Homebrew may put first on PATH.
swap_current() {
  ln -sfn "releases/$2" "$1/current.new"
  if [ "$(uname -s)" = Darwin ]; then
    /bin/mv -fh "$1/current.new" "$1/current"
  else
    mv -Tf "$1/current.new" "$1/current"
  fi
}

# Deletes every release dir except the tags given (the running one and the one to roll back to).
prune_releases() {
  local home="$1" d name
  shift
  for d in "$home"/releases/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    case " $* " in *" $name "*) continue ;; esac
    rm -rf "$d"
    echo "removed old release $name"
  done
}
