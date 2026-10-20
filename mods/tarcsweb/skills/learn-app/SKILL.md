---
name: learn-app
description: Learn how to run and test the current project's app, walk its main flows in the Browser panel, and write a per-project QA playbook skill (.claude/skills/app-qa/) that later sessions and validate-pr follow. Use when the user asks to learn, teach or map the app, set up app QA, or create a test playbook.
---

You are writing a playbook: the notes a new QA engineer would need to run this app and test it by hand. Later sessions load it as the `app-qa` skill, and `validate-pr` follows it. The playbook is a shortcut, never a rule: the user can always test in other ways.

## 1. Read before you ask

Read the repo first, so the questions you ask are only the ones the code cannot answer:
- README, CLAUDE.md, AGENTS.md, docs/.
- Package manager, scripts, Makefile, Procfile, docker-compose, `.env.example` and any config loader. Note the port, the start command and what the app needs to boot (database, queues, other services).
- Auth: how a user logs in (form, OAuth, magic link), and any seed or fixture that creates users.
- Routes or pages, and the features the code spends the most lines on.

If `.claude/skills/app-qa/SKILL.md` already exists, you are updating it: read it and keep what is still true.

## 2. Ask one round

Ask in a single round (mcp__app__ask_round when you have it), with your best guess as the recommended option:
- Which environment to test against: local only, or also a staging URL. Never production.
- Test accounts: the names of the environment variables that hold them (for example `QA_USER_EMAIL`, `QA_USER_PASSWORD`) and the local file that holds the values (`.env.local` or similar). Never ask the user to paste a secret into the chat.
- The 3-6 flows that matter most, if the code does not make them obvious.
- Anything off limits: payments, emails to real people, data that must not change.

## 3. Run the app and walk the flows

- Say what you will start and on which port before you start it. Run it in the background and wait until it answers.
- Walk each flow in the Browser panel. Hand multi-step walks to the `browser` subagent when you have it, one flow per call, with the URL and what to observe.
- If you have no `mcp__panel-playwright__*` or `mcp__panel-devtools__*` tools, the Browser panel is off for agents: tell the user to turn on the Agents switch in the Browser panel header, or ask which browser to use instead.
- Note what a tester needs to know: the landmarks on each page (headings, button labels), what success looks like, what data each step creates.

## 4. Write the playbook

Create `.claude/skills/app-qa/` in the project root:

```
.claude/skills/app-qa/
  SKILL.md        the playbook
  scripts/        optional: start, login, seed, reset helpers
```

SKILL.md frontmatter: `name: app-qa`, and a description that says it holds how to run and test this app and when to load it (testing a change, validating a PR, reproducing a bug).

Body sections, short and concrete:
- **Run**: install and start commands, the port, the readiness check (a URL and what it returns), how to stop it, and the services it needs.
- **Accounts**: one line per role with the env var names and the file they live in. Never a value.
- **Flows**: one numbered subsection per flow: the start URL, the steps, the expected result, and the data it creates or changes.
- **Data**: seed and reset commands, and which environment each one touches.
- **Off limits**: what a test must never do.

Scripts are optional. Write one only when a step is long or fiddly (a seed, a login that sets a cookie). Each script reads secrets from the environment, refuses to run against a production URL, and stays under ~40 lines.

## Rules

- No secrets in any file: no passwords, tokens, cookies or real customer data. Check that the env file holding the values is git-ignored; if it is not, tell the user.
- Change data only in local or staging environments.
- Do not commit. Show the user the files you wrote and ask them to review.
- Stop everything you started (app, containers, watchers) when you finish, unless the user wants it left running.
