# tarcsweb

Claude Code and Codex in one browser tab, running on your own computer.

```sh
npx tarcsweb
```

This package is the installer. It downloads the latest tarcsweb release from GitHub into `~/.local/share/tarcsweb`, builds it there and runs it as a background service on http://localhost:24816. Running it again updates to the latest release. It works on Linux with a systemd user session, on macOS and on Windows through WSL2.

`npx tarcsweb v0.5.1` installs a given version, and `npx tarcsweb --yes` answers yes to the installer's questions.

Requirements, screenshots and the uninstall command are in the [README on GitHub](https://github.com/TLucas97/tarcsweb#readme).
