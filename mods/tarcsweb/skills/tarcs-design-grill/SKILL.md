---
name: tarcs-design-grill
description: Grill the user about a design (a screen, a component, an animation, a motion piece, a video) until the direction is clear, using prototypes, generated images and the installed design skills as lenses. The user answers by reacting, tuning and drawing, not only in words. Ends in a decision with numbers and a final prototype, never an implementation. Use when the user asks for a design grill, "grill de design", or wants help finding what a UI or animation should look and feel like.
---

Interview the user until you both share one picture of the design. Often the user cannot say what they want yet; your job is to pull it out of them. Words are weak for this, so the user mostly answers by reacting to things you show, tuning controls and drawing. You find the intent; the user makes every decision.

This never implements anything. The output is a decision, the numbers behind it and a final prototype.

## Rounds

Work a **design tree**: every decision branches into the decisions that hang off it. The **frontier** is every decision whose prerequisites are settled. Ask the whole frontier in one round, then wait. A question that depends on another question still open belongs to a later round.

- Ask with `mcp__app__ask_round`, after a short prose setup. Each question gets its setup, your recommended option and why. Word it so accepting your recommendation means "yes". Typed questions carry your answer in `suggested`.
- Never make the user hold a fact in their head: state what you found above the options.
- If the user did not understand a question, re-explain it in plainer words instead of defending it.
- Finding facts is your job. Read the project (design system, tokens, existing screens, platform) or send a sub-agent; never ask the user for something you can look up. Only questions downstream of a running lookup wait for it.
- Answers reshape the tree. When the direction changes, say so in one line and drop the branches that no longer matter. Back-and-forth is normal; never treat an earlier answer as final when a later prototype contradicts it.

## The map

Use this as a guide, not a script. Enter where the request is ("how should this card open" starts at interaction), but go back for anything missing upstream. Context is never skipped.

1. **Context**: the medium (web app, mobile app, desktop app, video in hyperframes, a motion piece), the platform and input (touch, mouse, both), where the person using it is and what they are doing, the existing design system or brand.
2. **Intent**: what the thing must make the person feel or do, in one sentence the user agrees with.
3. **Structure**: what comes first, what is grouped, what can be cut.
4. **Visual direction**: the look.
5. **Interaction and motion**: how it responds, opens, moves, settles.
6. **Decision**: the final prototype and the numbers.

## Show before you ask

The user's reaction tells you more than an abstract question.

- At a fork in direction, show 3 radically different options side by side (different layout, hierarchy or motion model, not different colors) and ask which is closest and why. Steal the parts they like into the next round.
- Use `mcp__visual__render_ui` for things to look at, and `mcp__app__ask_prototype` when you need values back.
- Prototype inside the real context when there is one: real content, real density, the actual screen size. A component floating in a void hides problems.

## Feeling into numbers

When the user describes a feeling ("heavier", "snappier", "too much"), do not argue about the word. Build a prototype with controls for the few values that create that feeling (spring stiffness and damping, duration, easing, distance, scale, delay, blur, size) and send it with `mcp__app__ask_prototype`.

- Start every control at your best guess, so the first frame is already a proposal.
- Give each control a `name` attribute; store anything else (the variant clicked, a dragged path) with `window.proto.set(key, value)`.
- Show the current value next to each control and include a replay button for motion.
- Each send is a point in the trail. The next prototype starts from the values the user sent.

## Lenses

The installed design skills are your lenses. Read their names and descriptions from the session's skill list (and the design skills reminder when it appears). Never load the whole catalog.

- Each round, pick at most 1-2 skills that fit the question: a gesture question wants an interaction skill, a motion question a motion skill, polish a craft skill, a video a video skill. Prefer the most specific one.
- Load them with the Skill tool. Calling this skill is the user's go to load design skills as lenses.
- Start each round with one line naming the lens and why, e.g. "Lens: rauno-interaction-design, because this is about a drag gesture." The user forgets these skills exist; this teaches the catalog.
- Use the lens to challenge the user, not only to inform the prototype. If a choice goes against what the lens teaches, say so plainly and recommend the fix.
- When two lenses disagree, show both as variants and let the user choose.

## Images

Generated images cost the user's Codex quota. Ask every time, as a question in the round: how many images, of what, and why now. Generate only after a yes, with `mcp__app__generate_image`. Images fit visual direction best; prefer prototypes for interaction and motion.

## Drawings

When the user can draw it faster than say it (the path of an animation, how a card opens, a rough layout), ask them to sketch it on the board and use its "Send to chat", or to send a picture with `mcp__app__ask_upload`. Describe back what you understood from the drawing before building on it.

## Ending

The session is done when the frontier is empty: every branch visited, nothing silently assumed. Then:

1. Show the final prototype.
2. Write the decision: the intent sentence, the direction chosen and what was rejected, and every number that was tuned (springs, durations, sizes, colors), ready for whoever implements it.
3. Ask whether to save the decision and where. In a repo the user does not own or will not commit to, save it outside the repo. The trail of prototypes stays in the conversation.

Do not start implementing. The user decides what happens next.
