# tarcsweb

A web UI for Claude Code built on the TypeScript Agent SDK. It is often used to work on this very repo, so the app you are editing may be hosting your own session.

- `server/`: Node, `ws`, `@anthropic-ai/claude-agent-sdk`. Entry `server/index.ts`, one `Session` per conversation in `server/session.ts`.
- `web/src/`: React 19, Vite 8 with the React Compiler, zustand. Entry `web/src/main.tsx`, layout in `App.tsx`, all styles in `styles.css`.
- `server/protocol.ts` holds the types shared by both sides; the client imports it as `../../server/protocol.ts`.
- Package manager is pnpm. Never run `npm install`. Ask before adding a dependency.

## The running app

- Installed with `install.sh`, the app runs as the systemd user service `tarcsweb` (on macOS, the launchd agent `io.github.tlucas97.tarcsweb`) on `http://localhost:24816`: one server that serves the built client from `~/.cache/tarcsweb/dist` (`CW_DIST`).
- Install scripts run on macOS too: keep them bash 3.2 and BSD userland compatible, with OS branches in `scripts/service-lib.sh`.
- For development, `pnpm start` runs the server on 24817 and `pnpm dev:web` runs Vite with HMR on 24816.
- **Never kill or restart the app that hosts your own session.** Doing so ends the session and every agent in it. Let the user restart it (`systemctl --user restart tarcsweb`, or `launchctl kickstart -k gui/$(id -u)/io.github.tlucas97.tarcsweb` on macOS).
- With Vite running, client edits hot-reload into the open page, so never leave the client broken; non-HMR files (`ui/registry.ts`, plain `.ts` modules, `server/protocol.ts`, import cycles) trigger a full page reload. With the service, client edits show after `scripts/update.sh` or a rebuild.
- Server edits apply only after a restart. The one exception is `server/prompt.ts`: it is re-read when the file changes, and a session picks it up after right-click on its tab → Reload.
- Before asking for a restart, boot-check on a spare port: `CW_PORT=8799 setsid node server/index.ts`, curl it, then kill it.

## Test instances

- Use spare ports, one stack per agent, at most 3 stacks at a time (RAM is tight). Pairs: 8795/5189, 8796/5188, 8797/5187, 8798/5186.
- Start: `CW_PORT=P CW_ORIGINS=http://127.0.0.1:W,http://localhost:W setsid node server/index.ts &` and `CW_PORT=P setsid npx vite --port W --strictPort --logLevel warn &`.
- Stop: `kill $(lsof -t -i:W -i:P -sTCP:LISTEN)`. Never `pkill -f`.
- Never open the user's live session in a test instance. If you need a long real session, copy its transcript to a new id in a throwaway project folder and delete the copy afterwards.
- Avoid real model turns in tests; replay transcripts or feed events instead.

## Working rules

- Edit source with the Edit/Write tools only, never sed, heredocs or scripts. The UI shows changes as diff cards built from those tools.
- Do not write tests unless asked.
- Comments: 1-2 lines, only the why.
- Code, identifiers, comments and UI copy are in English.
- Do not commit unless asked. Commits are GPG-signed and carry no AI attribution.
- Verify with `npx tsc --noEmit -p tsconfig.json` from the repo root. Run `npx vite build` after touching `highlight.worker.ts` or the build config.
- UI is mouse-first: every flow must work by clicking; keyboard shortcuts are extras.

## Inline ```ui blocks

The model can write a fenced block with language `ui` holding one JSON object, and the client draws it (`web/src/UiBlock.tsx` → `web/src/ui/registry.ts`).

To add a block type:
1. Create `web/src/ui/foo.tsx` exporting `foo = defineUi({ schema, label, Component })`. Render it inside `<Card … stage={enter}>` from `ui/card.tsx`, where `enter` is a module-level function that builds the entrance from the DOM with the helpers in `ui/motion.ts`.
2. Add `foo` to `ui/registry.ts`.
3. Add one line to `VISUAL_PROMPT` in `server/prompt.ts`.

Schemas must stay backward compatible: old blocks live in saved transcripts. Use a CSS prefix (`ub-` for blocks) and keep each feature's CSS in its own commented section of `styles.css`.

## Performance rules

These come from measured audits (October 2026). Breaking one usually shows up as jank while a reply streams or as a slow session open.

**Rendering**
- Never define components inside render, including react-markdown `components`. Keep renderers at module level and pass per-message data (text, live) through context. An inline renderer remounts every code frame and ui block on every stream chunk.
- A finished code frame or ```ui block mounts once per message. After touching `Markdown.tsx`, `UiBlock.tsx` or `Code.tsx`, count mounts per chunk.
- Work done per stream chunk is proportional to the changed part, never to the whole message or conversation.
- Conversation rows stay `memo` and subscribe to their own item by id. Do not pass item data down from `Conversation`.

**State**
- Zustand selectors are O(1) and return a primitive or an existing reference. No `order.some/map/flatMap` over the conversation inside a selector; keep derived indexes in the reducer instead.
- Reducers create new objects only for the items they touch. Batch paths (the `events` backlog) copy `items`/`order` once per batch and call `setState` once.
- Every cache has a cap or a delete path: `convCache`, highlight caches, signed images, the motion `begun` map, per-session store maps when a session closes.

**Layout and observers**
- Never read layout (`clientWidth`, `getBoundingClientRect`, `scrollHeight`) in render or in a mount/no-deps layout effect. Read it in ResizeObserver, scroll or rAF callbacks, or use the observer's `contentRect`.
- Every effect that adds a listener or observer has a deps array and a cleanup. Use one shared document listener per feature, not one per message or block.
- Observer callbacks must not close over the element they observe (it keeps detached DOM alive).
- Never set CSS custom properties on `document.documentElement` from observers or per-frame code; set them on the element that uses them.

**Motion and paint**
- Animate only `transform` and `opacity`. `stroke-dashoffset` draws, number count-ups and `background-position` shimmers run on the main thread: skip them while a message is live.
- Create WAAPI animations only when a block nears the viewport, not on mount.
- Size and position changes use FLIP with transforms, not top/left/width/height keyframes.
- No `filter`, `backdrop-filter` or large `box-shadow` on per-message elements.
- Infinite animations stop under `prefers-reduced-motion` and while the tab is hidden.

**Loading**
- Iframes, images and syntax highlighting load near the viewport only.
- New panels, viewers and full-screen bodies load with `React.lazy`. `App.tsx` imports only what the first paint needs.

**Server and protocol**
- Start a CLI process on intent (typing or sending), not on view, and cap how many idle CLIs stay alive. Each one costs about 300 MB.
- Snapshots sent on a timer carry only changed rows. Long text (task, result, logs, diffs) loads on request.
- Never put base64 or binary data in events; store the file and send a signed URL.
- Every per-session collection that grows with the conversation has a cap, written next to the field. A session keeps only its newest events in memory (`LOG_MAX` in `server/coldLog.ts`); older ones live on disk and, for a resumed session, in the transcript before its last compaction. The `hello` backlog is that in-memory tail; older pages load with `history-load` as the reader scrolls up, and Find searches every event with `history-find`.
- The conversation mounts a bounded window of rows (`MOUNTED` in `Conversation.tsx`). Code that scrolls to a row goes through `convWindow.ts` (`reach`, `showRow`), which loads its page and mounts it first.
- Update cached lists in place on edits. Never call `listSessions` or `getSessionMessages` on a hot path.
- No synchronous fs calls or child processes on per-message paths. Cache git and fs facts with a TTL.
- Serialize a broadcast once, not once per client.

**Measuring**
- Check performance changes at 4x CPU throttle. At 1x this desktop hides jank.
- Measure with Playwright + CDP (traces, long tasks, mount counts) before and after a performance change.
