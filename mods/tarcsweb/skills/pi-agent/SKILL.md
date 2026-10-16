---
name: pi-agent
description: >-
  Spawn a one-shot Pi coding agent, monitor its progress, and collect its final result.
  Optional: needs the `pi` coding-agent CLI installed and configured. Use when the user
  explicitly asks to use Pi, delegate to Pi, get an independent coding agent, or when their
  request clearly calls for Pi delegation.
argument-hint: "<one bounded task for Pi>"
---

# Pi Agent

Delegate exactly one bounded coding task to a fresh, non-interactive Pi session. Pi runs in the target repository, can use its coding tools, streams progress, and exits after finishing.

## Requirements

This skill is optional. It needs the `pi` coding-agent CLI on `PATH`, already configured with a provider and credentials, plus `python3` for the runner. Before the first run in a session, check `command -v pi`. If it is missing, tell the user this skill needs the `pi` CLI installed and configured, and stop. Do not install it yourself.

## Invocation policy

Invoke this skill when:

- The user explicitly says to use, call, spawn, or delegate to Pi.
- The user invokes `/pi-agent`.
- The user's wording clearly requests a separate or independent coding agent.

Do not invoke Pi merely because a task is complex. Do not delegate destructive Git operations, production changes, secret handling, sudo/admin work, or irreversible actions without the user's explicit approval. Never put secrets in the delegated prompt.

`$ARGUMENTS` is the requested task when the skill is invoked explicitly. If it is empty and the task cannot be inferred unambiguously from the conversation, ask the user for one bounded task.

## Preflight

1. Identify the exact working directory. Pi inherits repository context from that directory.
2. Make the task self-contained: include the objective, relevant paths, constraints, expected verification, and what counts as done.
3. Assign Pi exclusive ownership of the delegated scope while it runs. Do not edit the same files concurrently.
4. Inspect the repository's existing changes before delegation. Tell Pi to preserve unrelated user work.
5. Do not count on Pi reading `CLAUDE.md` or `AGENTS.md`. Restate in its prompt every project or user rule from them that applies to the task (for example rules on tests, comments, or style).
6. Pi does not open PRs. If the task ends in a PR, Pi delivers the change and you write the description yourself, following the project's PR rules.

## Start Pi in the background

Use Claude Code's `Bash` tool with `run_in_background: true`. Run the helper from the target repository:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/run_pi_agent.py" \
  --cwd "$PWD" \
  --name "short task name" <<'PI_TASK'
Describe exactly one task here.

Scope:
- Name relevant files or modules.
- State constraints and non-goals.

Done when:
- State the expected result.
- Run the relevant tests, lint, typecheck, or build.
PI_TASK
```

Defaults:

- Provider, model and thinking level: Pi's own configured defaults
- Session: saved and named by Pi
- Mode: JSON event stream, summarized by the helper

Pass `--provider`, `--model` or `--thinking` only when the user names one or the task requires it:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/run_pi_agent.py" \
  --cwd "/absolute/repo/path" \
  --provider <provider> \
  --model <model> \
  --thinking high \
  --name "task name" <<'PI_TASK'
One bounded task.
PI_TASK
```

Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

Use `--no-session` only when the user requests an ephemeral run. Do not add `--approve` automatically: project trust is a security boundary. If Pi reports that trusted project resources are required, explain the issue and ask before rerunning with `--approve`.

## Observe progress

After launch:

1. Keep the background task ID returned by `Bash`.
2. Read the task's new output while Pi works (for example `TaskOutput` with `block: false`).
3. Report meaningful milestones briefly when useful. The helper emits lines such as:
   - `[pi] session ...`
   - `[pi] tool:start read`
   - `[pi] tool:end edit ok`
   - `[pi/assistant] ...`
   - `[pi/user] ...` (a message the user sent to Pi while it works; Pi follows it)
   - `[pi] finished exit=0`
4. Poll at reasonable intervals; do not busy-loop.
5. If the user asks to stop, terminate the background task through Claude Code's task controls.
6. A non-zero exit is a failed delegation. Read the error, report it, and do not claim completion.

## Review the result

Pi is an executor, not the final authority. After it exits:

1. Read Pi's final response.
2. Inspect the actual changed files or diff.
3. Run or confirm the relevant verification when practical.
4. Check that unrelated user changes were preserved.
5. Give the user a concise result: what Pi did, verification performed, and any remaining issue.

Do not silently redo Pi's work. If its result is incomplete or wrong, explain the gap and either fix it yourself within the user's authorization or delegate one new, clearly bounded follow-up task.
