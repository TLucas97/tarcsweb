---
name: replay
description: Build a visual, paged replay and open it with mcp__replay__open (terminal pane, or the tarcsweb viewer). Three formats - a code review of a GitHub PR, a branch or local work (optionally merged with another agent's review, /code-review or PR comments), a recap of the work just done in the session, or a concept explainer (an architecture, an algorithm, a library). Use when the user asks for a replay, a visual walkthrough, to go over what changed, or a visual explanation of a concept.
---

# Replay

A replay is a set of pages the user flips with `n`/`p` in a terminal pane or the tarcsweb viewer.
The goal: they understand what changed, why, how a person using the product will feel it, and
where to look harder, without reading every line. The quality of that hand-off is the whole
value. The pane only pages; questions and actions happen in the chat.

Check the host first: `printenv TARCSWEB`. `1` means tarcsweb, which shows each page as live
HTML in a browser viewer (**web mode**). Anything else is the terminal (**terminal mode**, the
default). Only the canvas rules in 7 and the checks in 8 differ between them.

Language: write page prose in the language the user writes in. The fixed strings below
("Points to decide", "point", "not verified", "confirmed", and so on) are given in English;
translate them to that language too.

## Formats

Pick one from the request. Page count follows the content (about 3-15), never a fixed number.

| Format | When | Shape |
|---|---|---|
| **Code review** | a PR, a branch or a diff to judge | `P1` panorama → per chapter: story, close-ups, impact → mechanical chapters → last page "Points to decide" (each point with its label, file:line, and a chip). Sections 1-6 apply in full. |
| **Work recap** | what was just done in this session | what changed and why, what to check by hand, risks. Shorter, no forced chapters; group pages by what the user should look at. Sections 1, 3 and 4 apply. |
| **Concept explainer** | understanding something general: an architecture, an algorithm, a library | builds from simple to complex, one idea per page, each page leaning on the last; a worked example beats a definition. Sections 1-6 do not apply. Interactive pages fit well here. |

Non-negotiable in a review or a recap: **nothing is hidden.** Every changed file lands on exactly
one page or chapter, the first page states the coverage with real numbers, and a summary that
claims "only X" carries the proof you actually ran. Never claim a check you did not run; write
"not verified" instead.

## 1. Get the change

| Source | Commands |
|---|---|
| PR link | `gh pr view <url> --json title,body,author,baseRefName,headRefName,additions,deletions,files,commits,reviews,comments` and `gh pr diff <url>` |
| Local work | `git status --short`, `git diff HEAD --numstat`, `git diff HEAD`, plus untracked: `git ls-files --others --exclude-standard` |
| Branch | `git diff --numstat <base>...HEAD`, `git diff <base>...HEAD` |

The `--numstat` file list is the **coverage ledger**. Keep it; the panorama is checked against it.
Skip generated files (lockfiles, snapshots, build output) from close reading, but they still
belong to a chapter ("generated") and count in coverage.

## 2. Split into chapters

- Group by intent, not by folder: a behaviour change, a migration, a new screen, a rename, config, tests.
- 3-7 chapters. Each file in exactly one.
- Tag each chapter with a risk (`high`, `medium`, `low`, `mech`) and a treatment:
  - **close-up**: real diff on the page (high risk, subtle logic, security, data, money).
  - **story**: a before/after diagram of the flow (a behaviour or architecture change).
  - **impact**: how a person using the product feels it (anything user-visible, see 4).
  - **proved summary**: mechanical chapters. Prove the claim with a command (reverse a rename with `sed` and diff, `git diff --word-diff`, count identical hunks) and pull out every exception.
  - **summary**: low risk, said plainly with numbers.

## 3. Read

- Close-ups: read the whole function around the hunk, not just the hunk. Pick at most 16 lines per page; split longer ones across pages.
- Look for what the description does not say: removed checks, changed defaults, new failure paths, unbounded loops, migrations without a way back, error handling that turns failures into success.
- Each finding gets a stable label `P<page> · point <n>` shown on the page, so the user can say "P3 point 1" in chat.

## 4. The human impact

For each chapter a person using the product can see or feel, write an **impact page**: a
named person in a concrete moment ("Maria places an order on the subway and loses signal"),
shown as screen or phone mocks, before vs after. When a finding has a user-facing failure, add
it as a third column ("If the API rejects it · P3·1") so the risk becomes something felt, not
read. No code on these pages. For internal-only changes, write "no change visible to users" in
the panorama instead of inventing impact.

## 5. Reviews from others

When the user brings a review (another agent's review, for example from a Codex agent,
`/code-review`, or PR review comments), attach each finding to the page where its code shows,
marked with its source (`codex`, `code-review`, `@login`). Check every finding against the code
first and say the verdict: `confirmed`, `not confirmed`, or `wrong` with one line why. Never
show another agent's claim as fact.

## 6. Big changes

Over ~1500 changed lines or ~30 files, delegate reading per chapter to subagents (follow any
project rules on subagents and models). Each returns a chapter draft: files, what changed, the
hunks worth a close-up (path and line range), findings with evidence, user-visible effect. The
main agent never loads the whole diff. It owns coverage, order, narrative and every page, and it
re-reads the exact lines of each close-up before drawing it.

## 7. Pages

Order follows the format (see Formats).

Rules for every page:
- Prose in the user's language, code as is. One idea per page. Title = the takeaway as a plain sentence, not a topic.
- Show, don't tell: at most ~25 words of prose outside code and mocks.
- Kicker line on top: review `<b>P3</b> · Chapter 1 · excerpt 1 of 3`; recap and explainer `<b>P3</b> · <short topic>`.
- **Terminal mode: fixed canvas, every page is 880×800 CSS px.** The mod always renders that size and only scales the picture to fit the pane, so the page looks the same in any pane. Design for exactly that box:
  - Everything fits in 800 px of height with no scroll. If it does not fit, split the page; never shrink text to make it fit.
  - Text never under 16px; code at the stylesheet's size.
  - Lay out with the stylesheet's classes, no fixed pixel widths on containers, flows of at most 4 nodes per row.
  - Never set `width`/`height` in the manifest, never size `html`/`body`, never add your own zoom or `transform: scale`.
  - The page is a static PNG: anything interactive shows only its first frame, so that frame must explain alone (the first step, the "after" state).
- **Web mode: a responsive page, 1200 px wide, any height.** The viewer shows it at up to 1200 px and reflows it on a narrower window, so it must still read at ~800 px.
  - Use the width: diff and notes side by side, cards in `.cols`, flows up to 6 nodes per row.
  - A page may scroll. Keep one idea per page, but a close-up plus its flow or a long hunk no longer needs splitting. Use `h2` for sections inside a tall page.
  - The viewer runs each page live in an iframe with scripts on. Add interactivity wherever it helps understanding: step-through buttons, a before/after toggle, a slider over a parameter, hover or click to reveal detail, tabs, `details.fold` for a hunk. The first view, with nothing clicked, must still explain alone.
  - Keep content text selectable (no `user-select:none` on it): the user selects text in a page to send it to the chat.
  - Text sizes, the no-scale rule and "never size `html`/`body`" still apply.
- Cards never get a thick colored edge (`border-left` accents read as generic). A verdict goes in the `.note` kind (`bad`, `good`, or none), which draws a glyph tile; page-specific CSS follows the same rule.
- Animate only what happens over time (a flow running, a state changing, a retry loop). Static otherwise, and the final frame must explain alone. Diagrams follow the `visual-explainer` skill (read it before the first diagram); motion follows the rules below, which are slower than that skill's.

### Motion that explains

Replay motion teaches, so it runs slower than UI motion. A fast animation the eye cannot follow is noise.

- The header (kicker, title, sub) is there from the first frame. Only the part that carries the explanation moves.
- One beat at a time: an element enters in 0.8-1.2 s (`power2.out`), then everything holds at least 1 s before the next beat. Beats the reader must follow never overlap; a stagger inside one beat is at least 0.4 s.
- A state change (a badge flipping, a token arriving) gets its own beat and a 1.5 s hold, so the reader sees before and after.
- Typical total 8-16 s, at most 20 s. `duration_ms` = last end + 1 s.
- No decoration: no pulsing, no looping, no movement that explains nothing.

Every page links the shared stylesheet first:

```html
<link rel="stylesheet" href="file://${CLAUDE_SKILL_DIR}/assets/replay.css">
```

Local files: name each one by its full literal `file://` path (media, `.css`, `.js`), never a path built in JS (`IMG + 'a.png'`); the web viewer rewrites only literal paths. The check flags the rest as `web:` lines.

Classes it provides:

| Page | Classes |
|---|---|
| any | `.kicker`, `h1`, `.sub`, `.plus`, `.minus`, `.chip` + `high`/`medium`/`low`/`mech`/`ok` |
| panorama | `.bar` with `<i style="flex:N">` + `hot`/`risk`/`mech`, `.ledger` (4 cells per row, chip wrapped in a `<span>`), `.coverage` / `.coverage.gap` |
| close-up | `.split`, `.diff` > `.ln` + `add`/`del`/`ctx`/`hot`, `.no`, `.sg`, `.gap`, `.mark` + `bad`/`good`, `.note` + `bad`/`good` with `.tag` and `.src` |
| story | `.lane` > `.lbl`, `.flow` > `.node` (+ `new`/`gone`) and `.arrow`, `.outcome` + `bad`/`good`, `.callout` |
| impact | `.phones` (`.two` for two), `.who` > `.lbl`, `.phone` > `.status`, `.screen-title`, `.row`, `.cta`, `.toast`; `.feel` + `bad`/`good` |
| mechanical | `.files` > `<i>` per file (`.odd` for an exception), `.proof`; `.side` for a 330 px column beside the rest |
| closing | `.point` > `.ref`, `.what`, `.where`, chip; `.foot-note` |
| web mode | `h2` (section), `.cols` (+ `two`/`three`) of `.card`, `details.fold` > `summary` (closed in the PNG) |

A close-up page, as a model for how the classes nest (copy the structure, not the content):

```html
<link rel="stylesheet" href="file://${CLAUDE_SKILL_DIR}/assets/replay.css">
<div class="kicker"><b>P3</b> · Chapter 1 · excerpt 1 of 3</div>
<h1>An API error turns into an endless retry</h1>
<div class="sub"><code>src/sync/syncQueue.ts</code> · lines 47-49</div>
<div class="split">
 <div class="diff">
  <div class="ln add"><span class="no">47</span><span class="sg">+</span>    } catch (err) {</div>
  <div class="ln add hot"><span class="no">48</span><span class="sg">+</span>      job.attempts += 1<span class="mark bad">1</span></div>
  <div class="ln add hot"><span class="no">49</span><span class="sg">+</span>      await queue.retryLater(job, backoff(job.attempts))</div>
 </div>
 <div>
  <div class="note bad"><div class="tag">P3 · point 1 <span class="src">· codex · confirmed</span></div>No retry limit. A 400 retries forever.</div>
 </div>
</div>
```

An impact page puts two or three `.who` columns in `.phones` ("Before", "After", and the
failure column from 4), each a `.phone` mock with a `.feel` line under it. A closing page is a
list of `.point` rows, one per point to decide.

## 8. Write, open, check

1. Write the pages and `replay.json` to `~/.cache/replay/<slug>/` (real disk; `<slug>` like `pr-123` or `local-2026-10-10`).
2. Manifest:
   ```json
   { "title": "PR #123 · offline sync",
     "pages": [ { "id": "P1", "title": "Panorama", "file": "p1-panorama.html" },
                { "id": "P4", "title": "Ch 1 · how users feel it", "file": "p4-impact.html", "duration_ms": 9500 } ] }
   ```
   `id` must match the kicker label. `duration_ms` only on animated pages. Terminal mode: leave out `width`/`height`, every page uses the standard 880×800 canvas. Web mode: give every page `"width": 1200` and `"height"` close to its real height (at most 1300, the mod's cap); the viewer sizes the page itself, the numbers only set the PNG check.
3. Call `mcp__replay__open` with the manifest's absolute `path` and `check: true`. It renders every page without showing anything and lists, per page, the PNG path and problems: console errors, failed requests, and `layout:` lines (content past the canvas edge, text clipped in a box, a page taller than the canvas).
4. Read the PNG of every page with a diagram, a mock or an animation, and every page with a problem. Fix clipped text, overlaps, empty halves and every `layout:` line, then check again with `check: true` until it is clean. Every PNG is the manifest size at 1.5×: 1320×1200 in terminal mode, 1800 wide in web mode; another size means a page or the manifest broke the canvas rule. In web mode the PNG shows only the first `height` px and folds closed, so put what needs checking there; a code line cut at the diff's edge scrolls in the browser but is still a defect to fix.
5. Show it: call the tool once **without** `check`. Each such call shows a new replay card in the user's chat, so never open a replay more than once; all fixing happens in check mode.
6. In the chat, reply briefly: how many pages, the 1-3 points to decide by label, and how to reopen it (terminal: `/replay`, `/replay 4` opens at P4; web: the replay card in the conversation). Do not repeat the replay's content in the chat.

When the user later asks about a page ("in P3 point 1..."), answer in the chat. Open the
replay again with `page` only when the user asks to see it.
