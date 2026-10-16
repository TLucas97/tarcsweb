# tarcsweb

A web UI for Claude Code, built on the TypeScript Agent SDK. It runs on your machine and uses your own Claude account: the subscription you signed in to with the `claude` CLI.

tarcsweb is an independent project, not made or endorsed by Anthropic.

## Install

You need:

- Linux with a systemd user session, which most desktop distros have
- Node 26 or newer and pnpm; the installer offers to set up both
- the `claude` CLI, signed in with your claude.ai account

Then run:

```sh
curl -fsSL https://raw.githubusercontent.com/TLucas97/tarcsweb/main/get.sh | bash
```

If you want to read the script first, download it, read it, then run it:

```sh
curl -fsSLO https://raw.githubusercontent.com/TLucas97/tarcsweb/main/get.sh
less get.sh
bash get.sh
```

`get.sh` downloads the latest release into `~/.local/share/tarcsweb/releases/<version>` without git and runs that release's `install.sh`. The install script installs the dependencies, builds the client and runs the app as a systemd user service (`tarcsweb`) on http://localhost:24816. It also adds a `tarcsweb` command and an app menu entry. Both start the app if it is stopped and open it in your default browser, which the installer also does when it finishes. Voice recaps (Kokoro TTS, about 350 MB) and ntfy phone notifications are optional, and it asks before setting them up.

To install a given version, pass it to the script, as in `bash get.sh v0.1.0` or `curl ... | bash -s -- v0.1.0`. Set `TARCSWEB_PORT` to use another port. Running it again is safe.

### Updates

tarcsweb only installs published GitHub releases, never the latest commit on a branch. It looks for a new release when it starts and every 6 hours. When one is out, a small notice shows up under the gear. Update installs it, Later hides it until the next release, and What's new opens the release notes. Settings > Updates shows your version, a Check now button and the same Update button.

An update downloads the new release next to the one you run, installs and builds it, and test-starts it on a spare port. Only after that does it switch over and restart the app; the page reconnects by itself. If a step fails, you keep the version you had, and the reason goes to `~/.cache/tarcsweb/update.log`. To go back after an update, run `get.sh` with the old version. That version is still on disk, so it skips the download.

### Uninstall

```sh
~/.local/share/tarcsweb/current/scripts/uninstall.sh
```

This removes the service, the `tarcsweb` command, the app menu entry and the installed releases. Your config (`~/.config/tarcsweb`) and cache (`~/.cache/tarcsweb`) stay unless you add `--purge`. The voice files in `~/.local/share/kokoro-tts` are not touched.

### Signing in

tarcsweb never asks for your Claude password. If the `claude` CLI is signed out, the app offers a "Sign in" button: it runs `claude auth login`, which opens the sign-in page in your browser, and you paste back the code that page shows. Signing in from a terminal with `claude auth login` works too. Settings shows the signed-in account and can sign it out, which also signs out the `claude` CLI.

### Rendering visuals

`render_ui` pictures and replays need a Chromium-based browser. The simplest option is `npx playwright install chromium-headless-shell`; an installed `chromium` or `google-chrome` also works.

## Settings

The gear at the top right opens Settings: your Claude account, the theme, the language of generated text, spoken recaps and phone notifications. It writes `~/.config/tarcsweb/config.json`:

- the language of generated text (summaries, error notes, spoken recaps, notifications): English or Brazilian Portuguese; the interface stays in English
- the ntfy topic for phone notifications: turning them on creates a random topic, which you subscribe to in the ntfy app

The file is readable only by you. You can also edit it by hand: `defaults` sets the permission mode, model and effort new sessions start with, `voice` sets the Kokoro voice and speed, and `ntfy.server` points at a self-hosted ntfy. Those hand edits apply after a restart (`systemctl --user restart tarcsweb`).

## Running it for development

You need Node 26 (it runs the server's `.ts` files directly) and pnpm.

```sh
pnpm install
pnpm start      # server on 127.0.0.1:24817
pnpm dev:web    # client on 127.0.0.1:24816
```

Open http://localhost:24816.

To run a git clone as the service instead, run `./install.sh` from its folder. It builds the client into `~/.cache/tarcsweb/dist` and serves it from the clone. A clone updates with git, through `scripts/update.sh`; the in-app Update button only works for release installs.

## How it fits together

The Node server owns one `Session` per conversation and talks to the browser over a single WebSocket at `/ws`. Vite serves the React client and proxies `/ws` and `/files` to the server.

| Path | What lives there |
| --- | --- |
| `server/protocol.ts` | Wire types shared by server and client |
| `server/config.ts` | The per-user config and its defaults |
| `server/session.ts` | One conversation: SDK query, events, permissions, handoff, MCP toggles, reload |
| `server/sessions.ts` | Open and past sessions, idle CLI limits |
| `server/agents.ts` | Agents panel rows: main thread, subagents, progress and step logs |
| `server/changes.ts` | Per-agent file changes behind the diff cards |
| `server/prompt.ts` | System prompt added to web sessions; re-read on change, applied with Reload on a tab |
| `mods/` | The Claude Code mods behind `render_ui`, replays and the agents panel, loaded into every session |
| `web/src/store.ts` | zustand store with one batched reducer per burst of events |
| `web/src/ui/` | The ` ```ui ` blocks (17 types) and their registry |

## What it does

- Sessions open as tabs in a dock. Ctrl/Cmd+K opens a palette to find, resume and start sessions by folder. Right-click on a tab to rename, reload or close it.
- Replies stream as markdown, with code colored by Shiki in a worker. The CLI only starts once you begin typing.
- Stretchtext replies: an answer arrives short, and each linked phrase grows in place when you click it. Claude is told which parts you opened. Settings > Appearance can switch to a plain reply with a short summary on top instead.
- Watch mode plays the session back as a small robot walking through its steps, live or from any point in the history.
- Questions with several options arrive as cards you click, one round at a time.
- Voice input (experimental): hold Space in the message box, or click the mic, and talk. A hidden Claude Code session transcribes it with Claude Code's own dictation, so it needs python3 and a claude.ai sign-in, and a Claude Code update can break it.
- Remote Control: right-click a tab to continue that session from the Claude app on your phone or from claude.ai/code. It needs a Pro or Max plan.
- Each reply has a Listen button that reads a short spoken recap of it (optional Kokoro TTS).
- Every agent that edits files gets a diff card per turn, and a click opens the full diff.
- The model can answer with visuals: `render_ui` pictures, paged replays, tables, choices to click, and ` ```ui ` blocks for charts, stats, timelines, checklists, diagrams, file lists, before and after, and trees.
- The Work panel shows one live checklist per agent (Main's plan and each subagent's steps) plus every file changed in the session.
- The agents panel lists the main thread and subagents with model, effort, tokens, progress and a stop button.
- Permission asks, mode, model and effort menus, an MCP menu, a usage meter and a context handoff card.
- Around the conversation: a file tree, an image viewer, find in page, guided inline reading, an explain panel for a selected excerpt, and "send to chat".

Your own skills, hooks, `CLAUDE.md` files and MCP servers from `~/.claude` work as they do in the CLI.

## Working on it

[CLAUDE.md](CLAUDE.md) has the rules for anyone, human or agent, changing this code, including about 30 measured performance rules. [AGENTS.md](AGENTS.md) points other coding agents to the same file.

## License

[MIT](LICENSE)
