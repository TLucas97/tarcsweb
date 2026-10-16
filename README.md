# tarcsweb

Claude Code in a browser tab, running on your own computer.

tarcsweb runs Claude Code through the Agent SDK and shows each session as a tab
in your browser. Replies render as markdown, every file edit becomes a diff card
you can open, and subagents report their progress in a panel of their own. It
uses the `claude` CLI you already signed in to, so your subscription, skills,
hooks, CLAUDE.md files and MCP servers work the same way they do in the terminal.

[![Install](https://img.shields.io/badge/install-one_line-d97757)](#install)
[![What you get](https://img.shields.io/badge/what_you_get-screenshots-555)](#what-you-get)
[![Uninstall](https://img.shields.io/badge/uninstall-one_line-555)](#uninstall)
[![MIT](https://img.shields.io/badge/license-MIT-555)](LICENSE)

![A tarcsweb session: the reply with code on the left, a diff card under it, and the Agents panel on the right with a subagent at work](assets/readme/hero.png)

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/TLucas97/tarcsweb/main/get.sh | bash
```

The installer runs tarcsweb as a background service on http://localhost:24816
and opens it in your browser when it finishes. It also adds a `tarcsweb` command
and an app menu entry, so you can open it again later.

You need:

- Linux with a systemd user session, or macOS
- Node 26 or newer and pnpm (the installer offers to install both)
- the `claude` CLI, signed in to your claude.ai account

<details>
<summary>Read the script before running it</summary>

```sh
curl -fsSLO https://raw.githubusercontent.com/TLucas97/tarcsweb/main/get.sh
less get.sh
bash get.sh
```

</details>

<details>
<summary>What the installer does, step by step</summary>

`get.sh` downloads the latest release into `~/.local/share/tarcsweb/releases/<version>` and runs that release's `install.sh`, which installs the dependencies, builds the client and starts the service. On Linux the service is the systemd user unit `tarcsweb`; on macOS it is the launchd agent `io.github.tlucas97.tarcsweb`. Spoken recaps (Kokoro TTS, about 350 MB) and phone notifications through ntfy are optional, and the installer asks before setting them up.

To install a given version, pass it along: `bash get.sh v0.1.4`, or `curl ... | bash -s -- v0.1.4`. `TARCSWEB_PORT` picks another port. Running the installer again is safe.

</details>

<details>
<summary>Notes for macOS</summary>

- Run the installer in Terminal while you are logged in at the Mac. The service lives in your login session, so it starts when you log in and stops when you log out.
- macOS leaves `~/.local/bin` off your PATH, and the installer prints the line that adds it: `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile`. Spotlight finds `tarcsweb.app` either way.
- Logs go to `~/Library/Logs/tarcsweb/tarcsweb.log`. Restart the app with `launchctl kickstart -k gui/$(id -u)/io.github.tlucas97.tarcsweb`.
- Voice input and spoken recaps need Python. Run `xcode-select --install` first, and `brew install python` for spoken recaps, which need Python 3.10 or newer.
- Voice input has not been tested on a Mac yet. If dictation fails, check for tarcsweb or node under System Settings > Privacy & Security > Microphone.

</details>

## What you get

### Sessions as tabs

Every conversation is a tab in the dock at the top. Ctrl+K (Cmd+K on a Mac) opens a palette that finds any session by folder or title: Enter resumes it, or you start a new session in that folder. Right-click a tab to rename, reload or close it.

![Ctrl+K: typing a folder name, picking a past session and resuming it](assets/readme/palette.gif)

A resumed session scrolls back to its very first message, older messages load in pages as you scroll up, and Find searches the whole session, including the parts not loaded yet.

### Short replies that grow when you click

Replies arrive short. Each underlined phrase holds more detail, and a click grows it in place, right where you are reading. Claude is told which parts you opened. If you prefer full answers with a short summary on top, switch Replies to Summary in Settings > Appearance.

![Clicking two underlined phrases in a reply; each one expands in place](assets/readme/stretch.gif)

### Every file change, as a diff

Each agent that edits files gets a diff card per turn. A click opens the full diff, with every file of that turn and a switch between split and unified views.

![A diff card in the conversation and the full diff it opens](assets/readme/diff.png)

### Answers with visuals

Claude can answer with charts, stats, tables, checklists, timelines, diagrams, file lists and before and after comparisons, drawn inside the reply. It can also render custom pictures and paged replays that walk you through a change. A replay's Listen button records a spoken summary of the whole replay that explains, in plain words, what it shows and why it matters.

![A reply with build stats, a before and after bar chart, and a checklist](assets/readme/visuals.png)

### Questions as cards

When Claude needs decisions from you, the questions arrive together in one card. Each one can mark a recommended option and say why. Pick an option or write your own answer, then send the whole round at once.

![A round of two questions with a recommended option and a field for your own answer](assets/readme/questions.png)

### Agents and their work

The Agents panel lists the main thread and every subagent with its model, effort, tokens and progress, and each one has a stop button. The Work panel keeps one live checklist per agent and every file changed in the session.

![The Agents panel with a running subagent, and the Work panel with the plan, the subagent's steps and the changed files](assets/readme/agents.png)

### Watch mode

Watch mode plays the session back as a small robot walking through its plan, step by step, with a lane for each subagent. It works live and from any point in the history.

![Watch mode: the robot walks to the next step while three subagent lanes report back](assets/readme/watch.gif)

### And also

- Voice input: hold Space in the message box, or click the mic, and talk. Claude Code's own dictation transcribes it, so it needs python3 and a claude.ai sign-in. It is experimental.
- Listen: each reply has a button that reads a short spoken recap of it aloud (needs the optional Kokoro install).
- Remote Control: right-click a tab to continue that session from the Claude app on your phone or from claude.ai/code. It needs a Pro or Max plan.
- Phone notifications through ntfy when a session waits for you or a long turn ends.
- Permission asks, mode, model and effort menus, an MCP menu, a usage meter, a file tree, an image viewer, guided reading and an explain panel for any excerpt you select.

## Settings

The gear at the top left opens Settings.

![The Settings dialog on the Appearance pane](assets/readme/settings.png)

Appearance (theme, font, text size, reply style) is saved in the browser. The rest goes to `~/.config/tarcsweb/config.json`, which only you can read:

- Account: the signed-in Claude account, with sign in and sign out.
- Language & voice: the language of generated text (summaries, recaps, notifications) in English or Brazilian Portuguese. The interface stays in English.
- Context: when a long session writes a handoff note and compacts, at 200k, 350k, 500k or 750k tokens, or off to leave it to Claude Code's own auto-compact.
- Notifications: turns on ntfy and creates a random topic for you to subscribe to.
- Updates: your version, Check now and Update.

You can also edit the file by hand. `defaults` sets the permission mode, model and effort that new sessions start with, `voice` sets the Kokoro voice and speed, and `ntfy.server` points at a self-hosted ntfy. Hand edits apply after a restart: `systemctl --user restart tarcsweb` on Linux, or the `launchctl kickstart` line above on macOS.

### Signing in

tarcsweb never asks for your Claude password. When the `claude` CLI is signed out, the app shows a Sign in button that runs `claude auth login`: it opens the sign-in page in your browser, and you paste back the code that page shows. `claude auth login` in a terminal works too.

### Rendering visuals

Custom pictures and replays need a Chromium-based browser on the machine. The simplest option is `npx playwright install chromium-headless-shell`. An installed `chromium` or `google-chrome` works too, and so does Google Chrome in `/Applications` on macOS.

## Updates

tarcsweb only installs published releases, never the latest commit on a branch. It checks for a new release when it starts and every 6 hours, and a small notice under the gear offers Update, Later and What's new.

An update downloads the new release next to the one you run, builds it and test-starts it on a spare port. Only then does it switch over and restart, and the page reconnects by itself. If any step fails, you keep the version you had, and the reason goes to `~/.cache/tarcsweb/update.log`. To go back to an older version, run `get.sh` with that version; it is still on disk, so nothing is downloaded.

## Uninstall

```sh
~/.local/share/tarcsweb/current/scripts/uninstall.sh
```

This removes the service, the `tarcsweb` command, the app entry and the installed releases. Your config (`~/.config/tarcsweb`) and cache (`~/.cache/tarcsweb`) stay unless you add `--purge`, which on macOS also deletes the logs. The voice files in `~/.local/share/kokoro-tts` are left alone.

## Development

You need Node 26 (the server runs its `.ts` files directly) and pnpm.

```sh
pnpm install
pnpm start      # server on 127.0.0.1:24817
pnpm dev:web    # client on 127.0.0.1:24816
```

Then open http://localhost:24816. To run a git clone as the service instead, run `./install.sh` from its folder. A clone updates with git through `scripts/update.sh`; the in-app Update button only works for release installs.

The Node server owns one `Session` per conversation and talks to the browser over a single WebSocket at `/ws`. Vite serves the React client and proxies `/ws` and `/files` to the server.

| Path | What lives there |
| --- | --- |
| `server/protocol.ts` | Wire types shared by server and client |
| `server/config.ts` | The per-user config and its defaults |
| `server/session.ts` | One conversation: SDK query, events, permissions, handoff, MCP toggles, reload |
| `server/sessions.ts` | Open and past sessions, idle CLI limits |
| `server/coldLog.ts` | Older events on disk, history pages and search |
| `server/agents.ts` | Agents panel rows: main thread, subagents, progress and step logs |
| `server/changes.ts` | Per-agent file changes behind the diff cards |
| `server/prompt.ts` | System prompt added to web sessions; re-read on change, applied with Reload on a tab |
| `mods/` | The Claude Code mods behind custom pictures, replays and the Agents panel |
| `web/src/store.ts` | zustand store with one batched reducer per burst of events |
| `web/src/ui/` | The ` ```ui ` blocks and their registry |

[CLAUDE.md](CLAUDE.md) has the rules for anyone changing this code, human or agent, including about 30 measured performance rules. [AGENTS.md](AGENTS.md) points other coding agents to the same file.

## License

[MIT](LICENSE). tarcsweb is an independent project and is not made or endorsed by Anthropic.
