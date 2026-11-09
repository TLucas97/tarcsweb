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
("Points to decide", "point", the mark names "Verified", "Explanation" and "Doubt", "confirmed",
and so on) are given in English; translate them to that language too.

## Budget

Read what the user wants to understand first, then spend the time on that and never on decoration. Never simplify a request just to finish sooner: a replay done in 2 minutes usually skipped something. In a blind test, a 2-minute replay lost to a slower one because it left out half the flow and had nothing the reader could try.

- Cover every step the request names, end to end: both sides of a request, open and close, and the failure path when it changes what the reader expects.
- **Teaching device.** Every page that explains a mechanism gets one small live device that proves it: a counter that shows a reload or not, a step timeline with the real values, a tiny simulation of the check. Build it from text and boxes. It counts as the page's figure. In blind tests these devices decided which replay readers learned more from.
- **Pick the figure that shows the core idea:** what stays put and what moves, what each layer or side holds, before and after. A row of step boxes is a list, not a figure; put the steps in text or code beside it.
- Decoration to skip: charts with made-up values, corner badges, thumbnails that repeat the text, and notes about how the replay was built.

- Build exactly what was asked: the page count the user names, or the fewest pages the format needs. Never add pages, variants or states nobody asked for. With an asked count, combine or cut instead of splitting a page.
- **Figure rule.** A drawn figure (SVG diagram, isometric figure, animated sequence) earns its place only when the idea is spatial, changes over time, or is a structure that text plus a short code excerpt cannot show. Then draw it: a figure that makes the mechanism click is worth the time. Decoration is not. At most one figure per page; the rest is text, boxes and code excerpts.
- Motion only shows order or change: one animated sequence per page at most.
- Load only this skill and what the request names. Do not pull in anatomy, visual-explainer or any other skill unless the user asks; the rules here cover diagrams, motion and figures.
- Write each page once, then fix it with small edits. Never rewrite a page from scratch.
- At most 2 check rounds (see 8).

## Formats

Pick one from the request. Page count follows the content (about 3-15), never a fixed number, within the budget above.

| Format | When | Shape |
|---|---|---|
| **Code review** | a PR, a branch or a diff to judge | `P1` panorama → per chapter: story, close-ups, impact → mechanical chapters → "Points to decide" (each point with its label, file:line, and a mark) → quiz. Sections 1-6 and 9 apply in full. |
| **Work recap** | what was just done in this session | what changed and why, what to check by hand, risks, then the quiz. Shorter, no forced chapters; group pages by what the user should look at. Sections 1, 3, 4 and 9 apply. |
| **Concept explainer** | understanding something general: an architecture, an algorithm, a library | builds from simple to complex, one idea per page, each page leaning on the last; a worked example beats a definition. Sections 1-6 and 9 do not apply. A figure fits here when the idea passes the figure rule. |

Non-negotiable in a review or a recap: **nothing is hidden, and every claim says how sure it is.**
Every changed file lands on exactly one page or chapter, the first page states the coverage with
real numbers, and a summary that claims "only X" carries the proof you actually ran. Every claim
carries one of the three marks in 3; never claim a check you did not run.

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

## 3. Read and mark

- Close-ups: read the whole function around the hunk, not just the hunk. Pick at most 16 lines per page; split longer ones across pages.
- Look for what the description does not say: removed checks, changed defaults, new failure paths, unbounded loops, migrations without a way back, error handling that turns failures into success.
- Each finding gets a stable label `P<page> · point <n>` shown on the page, so the user can say "P3 point 1" in chat.

Every claim on a review or recap page carries one mark, so the reader can tell what you know
from what you teach or guess:

| Mark | Means | Must carry |
|---|---|---|
| `<span class="mk verified">Verified</span>` | you read those lines or ran that command | its proof in `.ev`: `read · <code>Focus.tsx:376-384</code>` or `ran · <code>npx tsc</code> → 0 errors` |
| `<span class="mk explain">Explanation</span>` | context or teaching, not a claim about this change | nothing; it never says the code is right or wrong |
| `<span class="mk doubt">Doubt</span>` | may be wrong, or you did not check it | what would settle it in `.settle`: `Settled by: …` |

- A verified claim names exact evidence. Read only the hunk, not the function? Then it is a doubt.
- Certainty and verdict are separate: `.note.bad` says the code has a problem, the mark says how sure you are. A confirmed bug is `note bad` with `mk verified` in its tag.
- Where marks go: `.claims` > `.claim` rows (mark, text, then `.ev` or `.settle`; a finding's label leads its text in `<span class="ref">P3·1</span>`); in a `.note` tag, with the matching `note verified|explain|doubt` tile; in a `.point` or the ledger's last cell instead of a risk chip.
- P1 shows the legend as is: `<div class="legend"><span><span class="mk verified">Verified</span> read or ran; the proof comes with it</span><span><span class="mk explain">Explanation</span> context, claims nothing</span><span><span class="mk doubt">Doubt</span> may be wrong; says what would settle it</span></div>`
- Old pages with a `.chip medium` "not verified" still render; new pages use the marks.

## 4. The human impact

For the chapters a person using the product can see or feel, write an **impact page**, at most 2
per review (pick the chapters whose change is felt most): a
named person in a concrete moment ("Maria places an order on the subway and loses signal"), shown as
screen or phone mocks, before vs after. When a finding has a user-facing failure, add it as a
third column ("If the API rejects it · P3·1") so the risk becomes something felt, not read.
No code on these pages. For internal-only changes, write "no change visible to users" in the
panorama instead of inventing impact.

## 5. Reviews from others

When the user brings a review (another agent's review, for example from a Codex agent,
`/code-review`, or PR review comments), attach each finding to the page where its code shows,
marked with its source (`codex`, `code-review`, `@login`). Check every finding against the code
first and say the verdict: `confirmed`, `not confirmed`, or `wrong` with one line why. Never show another agent's claim as fact: until
you check it, it is a doubt; once checked, it is verified with your evidence.

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
  - Everything fits in 800 px of height with no scroll. If it does not fit, cut content or split the page; with an asked page count, combine or cut instead. Never shrink text to make it fit.
  - Text never under 16px; code at the stylesheet's size.
  - Lay out with the stylesheet's classes, no fixed pixel widths on containers, flows of at most 4 nodes per row.
  - Never set `width`/`height` in the manifest, never size `html`/`body`, never add your own zoom or `transform: scale`.
  - The page is a static PNG. An animated page is captured after its `duration_ms`, so the PNG is its final frame; anything interactive shows its unclicked state. Both must explain alone (the "after" state, the first step).
- **Web mode: a page that fills a full-window viewer, about 800-2500 px wide, any height.** The viewer covers the whole window and gives the page its full width with no cap; the page's CSS decides how to use it, so it must read well anywhere in that range.
  - Use the width in the first view. Put side by side what would otherwise stack: diff and notes, before and after, a flow next to its outcome, a mock next to its finding. Use plain `.cols` for cards (it adds columns as the window grows) and flows up to 6 nodes per row.
  - Never build one narrow centered column: no `max-width` or `margin:auto` on the page or a wrapper. The stylesheet already fills the width.
  - Prose keeps a readable line (about 80 characters): on a wide page `p`, `.sub`, `.proof`, `.note` and `.callout` cap their own width. Put card text in a `p` so it gets the cap. Code lines may run wider.
  - The viewer owns the edges: its bars float at the top and bottom, and it pads the page so they never cover it. Never add `position:fixed` or sticky bars at the top or bottom edge.
  - A page may scroll. Keep one idea per page, but a close-up plus its flow or a long hunk no longer needs splitting. Use `h2` for sections inside a tall page.
  - The viewer runs each page live in an iframe with scripts on. Add only the controls needed to carry the idea (or the quiz): step-through buttons, a before/after toggle, a slider over a parameter, hover or click to reveal detail, tabs, `details.fold` for a hunk. The first view, with nothing clicked, must still explain alone.
  - The viewer takes `n`, `p`, `r`, the arrows and Esc from the page. Form fields keep them, and so does a widget with `role` slider, radiogroup, tablist, listbox or spinbutton, or a `data-keys` attribute; give any custom keyboard widget one of those.
  - Keep content text selectable (no `user-select:none` on it): the user selects text in a page to send it to the chat.
  - Text sizes, the no-scale rule and "never size `html`/`body`" still apply.
- Cards never get a thick colored edge (`border-left` accents read as generic). A verdict goes in the `.note` kind (`bad`, `good`, or none), which draws a glyph tile; page-specific CSS follows the same rule.
- Animate only what happens over time (a flow running, a state changing, a retry loop). Static otherwise, and the final frame must explain alone. Diagrams use the story classes (`.lane`, `.flow`, `.node`, `.arrow`) and the figure rule in Budget; motion follows the rules below.

### Motion that explains

Replay motion teaches, so it runs slower than UI motion; a fast animation the eye cannot follow is
noise. When a review or recap changes a flow that runs in order, one animated page that plays it
once is worth it. One sequence per page at most; the rules below are all you need.

- Cast before timing. The header (kicker, title, sub) and containers are static from the first frame. Each beat has one lead, the thing the reader must watch; support follows it with less movement.
- Order shows cause. Sequence only cause and effect (the token arrives, then the badge flips). Parts of one moment move together; a stagger inside one beat is at least 0.4 s, shrinks along the group and starts with the most important item.
- One beat at a time: an element enters in 0.8-1.2 s (`power2.out`), then everything holds at least 1 s. A state change gets its own beat and a 1.5 s hold, so the reader sees before and after. A step line (a `.kicker` aside or the figure's readout) names the beat that plays.
- Move the real thing: a message is a pill that travels and parks where it arrived; a removed node leaves its slot while the rest close the gap.
- The end frame explains alone: everything parked, every label shown. It is the terminal PNG and what a returning reader sees.
- Reduced motion shows the end frame with no tween: `if (matchMedia('(prefers-reduced-motion: reduce)').matches) tl.progress(1)`. A step-through page jumps between steps.
- Typical total 8-16 s, at most 20 s. `duration_ms` = last end + 1 s. Animate `transform` and `opacity` (and `stroke-dashoffset` for a line that draws). No pulsing, no looping, no movement that explains nothing.

### Isometric figure pages (only when asked)

An `anatomy`-style figure, a small isometric machine whose working is the idea, costs far more
than a story page. Build one only when the user asks for an isometric figure, the idea passes
the figure rule, and the metaphor maps one-to-one onto the code. One per replay at most.

A plain SVG figure that passes the figure rule needs no request: draw it in the tokens on a story
page, without the anatomy skill.

- In tarcsweb, offer the figure through `mcp__app__visual_mode` with `figure: true`; the user picks it per replay. When picked, load `tarcsweb:iso-figure` (the small dedicated skill), follow it, and skip the anatomy bullets below.
- Only when the user names the full `anatomy` skill, load it and build a Figure (one mechanism, 40-80 parts) with its kit from a Node script kept outside the replay folder; paste the static SVG into the page. The projection is affine, so a moving part is a `<g>` shifted by screen offsets from the kit's `translateAlong` and tweened with GSAP; the page needs no kit runtime.
- Link `replay.css`, then the anatomy kit's `kit/iso.css` by its full `file://` path in that skill's folder, and wrap the plate in `<div class="iso fig" data-theme="light">`. `.fig` sets the corner labels and legend to 16px. Keep `data-theme="light"` in a themed replay too: `replay.css` rebuilds the kit's tones from the page tokens in dark. Give the SVG no colors of its own; the kit's classes paint it.
- Plate corners: `Fig n`, a short title, a hint and a readout that names the current step. Legend keys under the plate tie the lit part to the code. No words inside the drawing.
- Claims sit beside the figure (`.split`, figure first), each with its mark: the figure is an explanation; the claims say what is verified.
- The motion follows the rules above and ends on the outcome (the message parked, the shutter down). Terminal mode shows only that frame.

Every page links the shared stylesheet first:

```html
<link rel="stylesheet" href="file://${CLAUDE_SKILL_DIR}/assets/replay.css">
```

Local files: name each one by its full literal `file://` path (media, `.css`, `.js`), never a path built in JS (`IMG + 'a.png'`); the web viewer rewrites only literal paths. The check flags the rest as `web:` lines.

Colors come only from the stylesheet's tokens, so a themed replay (see 8) reads in light and in dark:
`--bg`, `--card`, `--paper`, `--ink`, `--muted`, `--faint`, `--line`, `--edge`, `--tint`, `--accent` and `--accent-tint`,
`--bad` and `--bad-tint`, `--coral`, `--info`, `--doubt`, `--add`/`--del` with `--add-bg`/`--del-bg`.
- Page CSS, inline styles, SVG `fill`/`stroke` (`fill="var(--ink)"` or a class) and chart options all use `var(--…)`. Never write a hex, rgb, `white` or `black`, and never redefine a token.
- Text on an `--ink`, `--accent` or `--bad` fill is `var(--bg)`, never white.
- `--faint` is for graphics only (strokes, arrows, dashed paths, glyphs): it is too light for text in dark. Quiet text uses `--muted`.
- A raster image keeps its own colors: give it a 1px `--edge` border, not a white panel behind it.

Classes it provides:

| Page | Classes |
|---|---|
| any | `.kicker`, `h1`, `.sub`, `.plus`, `.minus`, `.chip` + `high`/`medium`/`low`/`mech`/`ok` |
| panorama | `.bar` with `<i style="flex:N">` + `hot`/`risk`/`mech`, `.ledger` (4 cells per row, chip wrapped in a `<span>`), `.coverage` / `.coverage.gap` |
| close-up | `.split`, `.diff` > `.ln` + `add`/`del`/`ctx`/`hot`, `.no`, `.sg`, `.gap`, `.mark` + `bad`/`good`, `.note` + `bad`/`good` with `.tag` and `.src` |
| story | `.lane` > `.lbl`, `.flow` > `.node` (+ `new`/`gone`) and `.arrow`, `.outcome` + `bad`/`good`, `.callout` |
| impact | `.phones` (`.two` for two), `.who` > `.lbl`, `.phone` > `.status`, `.screen-title`, `.row`, `.cta`, `.toast`; `.feel` + `bad`/`good` |
| mechanical | `.files` > `<i>` per file (`.odd` for an exception), `.proof`; `.side` for a 330 px column beside the rest |
| closing | `.point` > `.ref`, `.what`, `.where`, chip or mark; `.foot-note` |
| marks | `.mk` + `verified`/`explain`/`doubt`; `.claims` > `.claim` with `.ev` or `.settle`; `.note` + `verified`/`explain`/`doubt`; `.legend` |
| figure | `.fig` on the kit's `.iso` wrapper (with its `iso.css`) |
| quiz | `.quiz` (`data-key`), `fieldset.q` (+ `open`) > `legend` with `.qn`, `.opts` > `label.opt`, or a `textarea`; `assets/quiz.js` |
| web mode | `h2` (section), `.cols` of `.card` (plain grows with the window; `two`/`three` fix the count), `details.fold` > `summary` (closed in the PNG) |

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
  <div class="note bad"><div class="tag">P3 · point 1 <span class="mk verified">Verified</span> <span class="src">· codex · confirmed</span></div>No retry limit. A 400 retries forever.</div>
 </div>
</div>
```

An impact page puts two or three `.who` columns in `.phones` ("Before", "After", and the
failure column from 4), each a `.phone` mock with a `.feel` line under it. A closing page is a
list of `.point` rows, one per point to decide.

## 8. Write, open, check

1. Write the pages and `replay.json` to `~/.cache/replay/<slug>/` (real disk; `<slug>` like `pr-482` or `local-2026-10-10`).
2. Manifest:
   ```json
   { "title": "PR #482 · offline sync", "theme": "auto",
     "pages": [ { "id": "P1", "title": "Panorama", "file": "p1-panorama.html" },
                { "id": "P4", "title": "Ch 1 · how users feel it", "file": "p4-impact.html", "duration_ms": 9500 } ] }
   ```
   `"theme": "auto"` makes the pages follow the tarcsweb app's light or dark theme, and the web check renders them dark; every new replay sets it and paints only with the tokens (see 7). A manifest without it stays light, and terminal mode is always light. `id` must match the kicker label. `duration_ms` only on animated pages. Terminal mode: leave out `width`/`height`, every page uses the standard 880×800 canvas. Web mode: give every page `"width": 1300` and `"height"` close to its real height (both at most 1300, the check's cap); the viewer sizes the page itself, the numbers only set the PNG check. The check cannot show wider than 1300, so build wide layouts from the stylesheet's grids, which keep adapting up to 2500.
3. Call `mcp__replay__open` with the manifest's absolute `path` and `check: true`. It renders every page without showing anything and lists, per page, the PNG path and problems: console errors, failed requests, and `layout:` lines (content past the canvas edge, text clipped in a box, a page taller than the canvas).
4. Read the PNG of every page with a diagram, a mock or an animation, and every page with a problem. Fix only what a reader would notice: overflow, overlap, cut or unreadable text, a broken script, every `layout:` line. Fix with small edits, then check again. At most 2 check rounds; stop as soon as one is clean. Every PNG is the manifest size at 1.5×: 1320×1200 in terminal mode, 1950 wide in web mode; another size means a page or the manifest broke the canvas rule. In web mode the PNG shows only the first `height` px and folds closed, so put what needs checking there; a code line cut at the diff's edge scrolls in the browser but is still a defect to fix.
5. Show it: call the tool once **without** `check`. Each such call shows a new replay card in the user's chat, so never open a replay more than once; all fixing happens in check mode, within those 2 rounds.
6. In the chat, reply briefly: how many pages, the 1-3 points to decide by label, and how to reopen it (terminal: `/replay`, `/replay 4` opens at P4; web: the replay card in the conversation). Do not repeat the replay's content in the chat.

When the user later asks about a page ("in P3 point 1..."), answer in the chat. Open the
replay again with `page` only when the user asks to see it.

## 9. Quiz (review and recap)

The last page of a review or a recap is a quiz: 3-4 multiple-choice questions and 1-2 open ones
about what the reader needs to approve or keep working (a risk, a behaviour change, why a guard
exists), never trivia like file names or line counts. Each question comes from one page.

The page holds the questions only; the key lives in `quiz.json` next to `replay.json`.
`assets/quiz.js` adds the option letters, the send and copy buttons and the status line:

```html
<link rel="stylesheet" href="file://${CLAUDE_SKILL_DIR}/assets/replay.css">
<div class="kicker"><b>P7</b> · Quiz</div>
<h1>Check what stuck before moving on</h1>
<div class="sub">4 multiple choice and 1 open · the answers go to the chat for grading</div>
<div class="quiz" data-key="<absolute path of ~/.cache/replay/<slug>/quiz.json>">
 <fieldset class="q" data-id="q1"><legend><span class="qn">1</span>Question…</legend><div class="opts">
  <label class="opt"><input type="radio" value="a"><span>Option…</span></label>
 </div></fieldset>
 <fieldset class="q open" data-id="q5"><legend><span class="qn">5</span>Open question…</legend><textarea></textarea></fieldset>
</div>
<script src="file://${CLAUDE_SKILL_DIR}/assets/quiz.js"></script>
```

- Option values are `a`-`d` in order; spread the right letters. Wrong options are plausible misreadings.
- The key file must be named `quiz.json` and sit beside `replay.json`: the viewer names that file itself and ignores the page. `data-key` (its plain absolute path, no `file://`) only feeds "Copy answers" in a browser tab. The page entry has no `duration_ms`.
- `quiz.json`: `{ "replay": "<abs path of replay.json>", "questions": [ { "id": "q1", "page": "P3", "kind": "choice", "question": "…", "answer": "b", "why": "one line" }, { "id": "q5", "page": "P4", "kind": "open", "question": "…", "covers": ["a point a good answer names", "…"] } ] }`
- Web mode: "Send answers to the chat" puts a message starting `Quiz answers` in the composer, with the key path; the user sends it. A browser tab offers "Copy answers" with the same text.
- Terminal mode: one question per page (`P7 · Quiz 1/5`), each its own `<div class="quiz" data-still>`, which draws no buttons. These pages count toward the page budget: with an asked count, ask fewer questions or put two on a page. The pages are still pictures: the `.sub` tells the user to answer in the chat ("1b 2a 3d 4c, and 5: …").

When answers arrive, grade them:
1. Read `quiz.json` from the path in the message (or the replay you just made).
2. A choice is right only on the exact letter. An open answer is right when it covers every `covers` point in the user's own words, partly right when it covers some.
3. For each miss: the right answer, one line why, and the page to reread (`see P3`). Do not re-teach the page.
4. End with one plain sentence: everything is right, or what to reread. The quiz is a self-check, not a lock: never block, gate or refuse anything on the score.
