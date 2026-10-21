#!/usr/bin/env bash
# Installs or updates tarcsweb from a GitHub release, without git, on Linux or macOS. Safe to re-run; bash 3.2 compatible.
#   curl -fsSL https://raw.githubusercontent.com/TLucas97/tarcsweb/main/get.sh | bash
#   bash get.sh [version] [--yes]      e.g. bash get.sh v0.1.1
# Env: TARCSWEB_HOME (install root), TARCSWEB_API (release API base), GITHUB_TOKEN (optional, raises the API rate limit),
#   and install.sh's own (TARCSWEB_PORT, ...).
set -euo pipefail

REPO_SLUG="TLucas97/tarcsweb"

API="${TARCSWEB_API:-https://api.github.com}"
HOME_DIR="${TARCSWEB_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/tarcsweb}"
RELEASES="$HOME_DIR/releases"
TMP=""

say() { printf '\n==> %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }

usage() {
  cat >&2 << EOF
Usage: get.sh [version] [--yes]
Installs the latest tarcsweb release (or the given version) into $HOME_DIR.
  version     a release tag such as v0.1.1 (default: the latest release)
  --yes, -y   answer yes to install.sh's questions (Node, pnpm, voice)
EOF
}

# First string value of a JSON key; works on compact and pretty-printed JSON.
json_str() {
  { grep -o "\"$1\": *\"[^\"]*\"" || true; } | head -n 1 | sed 's/^"[^"]*": *"\(.*\)"$/\1/'
}

# curl for the GitHub API. A GITHUB_TOKEN goes only to api.github.com, through stdin so it stays out of the process list.
api_curl() {
  if [ -n "${GITHUB_TOKEN:-}" ] && [ "$API" = https://api.github.com ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" | curl -K - "$@"
  else
    curl "$@"
  fi
}

# The latest tag, read from where github.com/<repo>/releases/latest redirects; it has no API rate limit.
latest_tag_from_redirect() {
  local location
  location="$(curl -sI --max-time 30 "https://github.com/$REPO_SLUG/releases/latest" | tr -d '\r' | awk 'tolower($1) == "location:" { print $2; exit }')" || true
  printf '%s' "${location##*/}"
}

# Prints the release JSON for "latest" or a tag.
fetch_release() {
  local url out code tag
  if [ "$1" = latest ]; then url="$API/repos/$REPO_SLUG/releases/latest"; else url="$API/repos/$REPO_SLUG/releases/tags/$1"; fi
  out="$(api_curl -sSL --max-time 30 -H 'Accept: application/vnd.github+json' -w '\n%{http_code}' "$url")" || die "could not reach $API (are you offline?)"
  code="${out##*$'\n'}"
  case "$code" in
    200) printf '%s' "${out%$'\n'*}" ;;
    404) if [ "$1" = latest ]; then die "$REPO_SLUG has no published release yet"; else die "release $1 not found in $REPO_SLUG"; fi ;;
    403 | 429)
      # Only the tag is needed; main falls back to the archive URL for the tarball.
      if [ "$API" = https://api.github.com ]; then
        echo "GitHub's API rate limit was reached; reading the release from github.com instead (set GITHUB_TOKEN to raise the limit)" >&2
        if [ "$1" = latest ]; then tag="$(latest_tag_from_redirect)"; else tag="$1"; fi
        if [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then printf '{"tag_name": "%s"}' "$tag"; return 0; fi
      fi
      die "GitHub's API rate limit was reached; try again in an hour, or set GITHUB_TOKEN"
      ;;
    *) die "GitHub's API answered HTTP $code for $url" ;;
  esac
}

# Wrapped in a function so `curl | bash` reads the whole script before running any of it.
main() {
  local want=latest fetch_only=0 arg
  local pass=()
  for arg in "$@"; do
    case "$arg" in
      -h | --help) usage; return 0 ;;
      -y | --yes) pass+=("--yes") ;;
      --fetch-only) fetch_only=1 ;;
      -*) usage; die "unknown option $arg" ;;
      *) want="v${arg#v}" ;;
    esac
  done

  case "$(uname -s)" in
    Linux | Darwin) ;;
    *) die "tarcsweb supports Linux and macOS only" ;;
  esac
  for arg in curl tar gzip; do command -v "$arg" > /dev/null || die "$arg is required"; done

  say "Looking up the $want release of $REPO_SLUG"
  local json tag tarball
  json="$(fetch_release "$want")"
  tag="$(printf '%s' "$json" | json_str tag_name)"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || die "unexpected release tag '$tag'"
  tarball="$(printf '%s' "$json" | json_str tarball_url)"
  [[ "$tarball" =~ ^https?:// ]] || tarball="https://github.com/$REPO_SLUG/archive/refs/tags/$tag.tar.gz"
  echo "release $tag" >&2

  local dest="$RELEASES/$tag"
  if [ -f "$dest/.tarcsweb-release" ]; then
    echo "already downloaded in $dest" >&2
  else
    say "Downloading $tag"
    mkdir -p "$RELEASES"
    TMP="$(mktemp -d "$RELEASES/.get-XXXXXX")"
    trap cleanup EXIT
    curl -fSL --retry 3 --max-time 600 -o "$TMP/src.tar.gz" "$tarball" || die "download of $tarball failed"
    mkdir "$TMP/src"
    tar -xzf "$TMP/src.tar.gz" -C "$TMP/src" --strip-components=1 --no-same-owner || die "could not extract the release archive"
    [ -f "$TMP/src/package.json" ] && [ -f "$TMP/src/install.sh" ] || die "the archive does not look like tarcsweb"
    # Marks a finished extraction; install.sh and the server read it to know this is a release install.
    printf '%s\n' "$tag" > "$TMP/src/.tarcsweb-release"
    rm -rf "$dest"
    mv "$TMP/src" "$dest"
    echo "extracted into $dest" >&2
  fi

  if [ "$fetch_only" = 1 ]; then
    printf '%s\n' "$dest"
    return 0
  fi

  # install.sh builds inside the release dir, then points $HOME_DIR/current at it and restarts the service.
  say "Running $tag's install.sh"
  # Bash 3.2 (macOS) treats "${pass[@]}" of an empty array as unbound under set -u.
  TARCSWEB_HOME="$HOME_DIR" bash "$dest/install.sh" ${pass[@]+"${pass[@]}"} < /dev/null
}

main "$@"
