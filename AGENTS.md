# Repository Guidelines

## Project Structure & Module Organization

This repository holds personal configuration for the **pi coding agent** (themes, extensions, prompts, skills). There is no application source code.

- `extensions/` — TypeScript extension modules (e.g., `shell-timeout.ts`). Each file default-exports a function receiving `ExtensionAPI` and registers hooks such as `pi.on("tool_call", ...)`.
- `prompts/` — Markdown prompt templates (`commit.md`, `init.md`) with YAML frontmatter (`description`, `argument-hint`); support `${ARGUMENTS:-default}` substitution.
- `skills/` — One directory per skill, each containing a `SKILL.md` with YAML frontmatter (`name`, `description`, `license`).
- `themes/` — JSON theme files (e.g., `selenized-dark.json`) validated against pi's theme schema.
- `settings.json` — Top-level agent settings (editor command, active theme).

## Build, Test, and Development Commands

No build or test tooling exists (no `package.json`); files are consumed directly by pi.

- **Validate a theme:** ensure JSON parses (`node -e "require('./themes/<file>.json')"`) and keys match pi's theme schema.
- **Type-check extensions:** `npx tsc --noEmit extensions/<file>.ts` (types come from `@earendil-works/pi-coding-agent`).
- **Apply changes:** restart pi or run `/reload`.

## Coding Style & Naming Conventions

- TypeScript: tab indentation, double quotes, trailing commas, camelCase filenames (`ask-user-question.ts` uses kebab-case — prefer kebab-case for new files).
- Extensions must default-export `function (pi: ExtensionAPI)`; keep constants and comments at the top of the file.
- Prompts/skills/themes: kebab-case or lowercase names; YAML frontmatter at the very top.
- Keep `.env`, credentials, and tokens out of the repo (enforced by `.gitignore`).

## Testing Guidelines

No automated test framework. Validate manually:

1. Run `/reload` in pi after editing extensions, prompts, skills, or themes.
2. Invoke the changed command/extension and confirm behavior and UI rendering.

## Commit & Pull Request Guidelines

History follows **Conventional Commits**: `<type>[scope]: <description>` in imperative mood, description under 72 characters (e.g., `feat(extensions): add ask-user-question and shell-timeout extensions`). Use scopes matching top-level folders (`config`, `extensions`). Stage only related files; never stage secrets. Use the `/commit` prompt, which delegates to the `git-commit` skill. Pull requests (if any) should state the change, the affected folder, and manual verification steps.
