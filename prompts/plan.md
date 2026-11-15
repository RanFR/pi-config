---
description: Turn a task description into a complete, self-contained plan file that a later session can execute directly
argument-hint: "<task description>"
---

Produce ONE complete plan document and save it to a file. Do not implement it.

Task: ${ARGUMENTS:-<no task given - ask me what to plan>}

## Process (single pass)

1. Explore the repo read-only to ground the plan in reality: relevant files, entrypoints, configs, existing patterns, and project conventions (AGENTS.md, docs). Allowed: reading files, listing directories, git status/log, and other non-mutating commands. Forbidden: installing dependencies, running formatters/linters/codegen, applying patches, or touching lockfiles. Running tests/builds is acceptable only when they write nothing but untracked artifacts. The ONLY file you may create is the plan file, and the ONLY directory you may create is `.pi/plans/`.
2. Do not interrupt me with questions. If a detail is genuinely blocking (the task cannot be planned at all without it), ask exactly one targeted question via the `ask_user_question` tool; otherwise make reasonable choices and record them as assumptions. Only a completely missing or whitespace-only task counts as blocking — a task that is merely vague must be planned with assumptions, not questions.
3. If exploration hits limits (empty repo, no relevant files found, no tests, uncommitted changes, task description contradicting the code), do not stop unless planning is truly impossible: record what you found in `Assumptions` or `Open questions` and proceed. Stop and report only when no meaningful plan can be written.
4. Write the plan file to `.pi/plans/<YYYY-MM-DD>-<short-slug>.md` inside the **current working directory** (the project root where this pi session was launched). Resolve the path against the cwd — do NOT write into `~/.pi/agent`, the user home directory, any global config location, or any parent directory of the cwd. Use the current local date. If the target file already exists, stop and report the conflict — do not overwrite. If the target directory is not writable, report the failure — do not write elsewhere. Create the `.pi/plans/` directory if it does not exist; slug is 2-4 words from the task.
5. After writing, verify: the file exists at the intended path, is non-empty, contains all required sections, and no other files were modified.
6. Reply with just the file path and a 2-3 line summary of the approach.

## Self-containment requirement

The file is the ONLY thing a future session will see. It must not depend on this conversation. Embed everything the implementer needs: background, current-state findings (paths, symbols, behaviors), locked decisions, ordered steps, and verification commands. A fresh session that reads only this file must be able to do the work.

## Document format

Use exactly this structure:

```markdown
# Plan: <title>

> Date: <YYYY-MM-DD> | Status: draft
>
> Execution instructions for the agent reading this file: implement this plan. Follow "Implementation steps" in order; tick each checkbox when its verification passes. First re-verify the current state matches "Background" — if reality has drifted or contradicts the plan, stop and report instead of improvising. Do not redo design decisions; they are locked below.

## Background & current state
What exists today that this task touches: file paths, key symbols, current behavior, constraints discovered during exploration. Enough for a fresh session to orient without re-doing the exploration.

## Goal & success criteria
The outcome and how to tell it is achieved.

## Decisions
Locked design decisions, each with a one-line rationale. The implementer must not reopen these.

## Changes
Grouped by subsystem or behavior, not file by file. Behavior-level bullets; name specific paths only where it prevents mistakes. Call out public API, type, or interface changes explicitly.

## Implementation steps
Ordered checklist, each step small and independently verifiable:
- [ ] Step text; on the next line the exact command, a concrete file/symbol check, or an explicit acceptance criterion that verifies it. Never invent a command that you are not sure exists — if no command applies, state the check instead.
Last steps: run the repo's required checks/tests and report results.

## Test plan
Scenarios with acceptance criteria, including edge and failure cases.

## Assumptions
Choices made for anything not specified, so the implementer does not have to guess.

## Open questions
Non-blocking unknowns, each with the default being used unless the user says otherwise.
```

## Final rules

- Language: write the plan in the primary language of my task description (if mixed, the majority natural language; if undeterminable, English). Keep code, commands, paths, and identifiers verbatim.
- Keep every listed top-level section even when a section does not apply — write `None` rather than dropping it. Do not add extra top-level sections.

- Complete and concise: minimum detail needed for implementation safety. No filler steps, no restating the obvious, no exhaustive file inventories. A straightforward task gets a short plan — that is correct, not lazy.
- Do not invent detailed schema, validation, or fallback policy unless the task requires it or skipping it would cause a concrete implementation mistake.
- Do not ask "should I proceed?" and do not implement anything.
