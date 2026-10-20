---
name: validate-pr
description: Validate a pull request by hand like a QA engineer - check it out in a separate worktree, run the app, test the flows the diff touches in the Browser panel, record a video and report what passed and failed. Use when the user asks to validate, QA, test or check a PR in the running app.
---

You test a PR the way a QA engineer would: run the changed app and use it. You never edit the PR's code, and you never post to GitHub unless the user asks. The user can steer any step; follow their method over this one.

## 1. Understand the change

- Get the PR from the user's message (number or URL). If none was given, ask.
- Read it: `gh pr view <n> --json number,title,body,headRefOid,baseRefName,files` and `gh pr diff <n>`.
- Load the project's playbook if it exists: the `app-qa` skill, or `.claude/skills/app-qa/SKILL.md`. Without one, offer the `learn-app` skill first, or go ahead with what the repo's README and scripts tell you if the user prefers.
- List the flows the diff can affect: the playbook flows that touch the changed files, plus any new screen or behavior the PR describes. Show that list and the plan in one short message before you start.

## 2. Check out the PR

- Fetch without creating a branch: `git fetch origin <headRefOid>` (or `git fetch origin pull/<n>/head` when the commit is not reachable).
- Add a detached worktree next to the repo, on real disk: `git worktree add --detach ../<repo>-pr-<n> <headRefOid>`. Check with `findmnt -no FSTYPE -T <dir>` that it is not on tmpfs; if it is, pick another folder and say why.
- Dependencies: when the lockfile matches the main checkout's, reuse its installed dependencies (symlink `node_modules`, point the tool at the existing cache). A fresh install costs disk and time: ask before running one.

## 3. Run the app

- Before you start anything, check where the app will point: in the env file the playbook names, look only at the hosts of the variables that set where it connects (database URL, API base URL, and similar) and confirm they are local or staging. If one points at production, or you cannot tell, stop and ask. Never print secret values.
- Copy only that env file into the worktree, and only from the user's main checkout.
- Start the app as the playbook says, on a port nothing else uses. Say what you start and on which port.
- Wait for the readiness check, then run the playbook's seed when the flows need data.

## 4. Test and record

- Start a recording with mcp__app__browser_record (action start, title "PR <n>: <short title>") when you have it.
- Hand each flow to the `browser` subagent when you have it: one call per flow, with the start URL, the steps, the expected result and the env var names for the login. Ask it to report console errors and failed requests too.
- If you have no `mcp__panel-playwright__*` or `mcp__panel-devtools__*` tools, the Browser panel is off for agents: tell the user to turn on the Agents switch in the Browser panel header, or ask which browser to use.
- Check what changed first, then one or two nearby flows for regressions.
- Stop the recording when the last flow ends.

## 5. Report

Report in the chat, in this order:
- A one-line verdict: works, works with issues, or broken.
- A checklist of each flow tested with pass or fail, and for each failure the URL, what happened, what was expected and the console or network evidence.
- The video, and anything you could not test, with the reason.

Offer, do not do: posting the report as a PR comment, or opening an issue.

## 6. Clean up

- Stop the app and anything else you started.
- Remove the worktree you created with `git worktree remove ../<repo>-pr-<n>`. Keep the recording.
- Leave the user's main checkout, branches and env files as they were.
