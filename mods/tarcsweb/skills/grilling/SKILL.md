---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Each question is formatted like so:

```
❓ **Q1** - **<short question title>**

<the setup: what situation forces this decision. Short sentences, one idea each.>

- **A**: <option, in plain words>
- **B**: <option, in plain words>
- **C**: <option, in plain words>

➡️ **<your pick>**. <one or two sentences on why, and what the rejected options cost.>
```

Write the questions to be understood on the first read. One idea per sentence, active voice, everyday words. Put the setup before the options, never inside them. Give the options as a short labelled list, not as prose the reader has to parse. Keep each option to a line. A question that needs three paragraphs of setup is two questions.

Never make the user hold a fact in their head to answer. If a decision depends on something you found (a constraint in the code, a limit in an API, what a competitor does), state it above the options, in one line, before asking.

When the user says they did not understand a question, re-explain it rather than defending it: strip the jargon, name the one thing being decided, and drop any part of the question that was actually a different question.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
