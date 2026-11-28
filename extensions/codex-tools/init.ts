/**
 * `/init` command: analyzes the repository and writes an AGENTS.md contributor guide.
 *
 * Replaces the previous ~/.pi/agent/prompts/init.md prompt template: the
 * AGENTS.md existence check runs in the extension instead of the prompt, and
 * extra instructions can be passed as arguments (`/init focus on testing`).
 *
 * Adapts material from OpenAI Codex (https://github.com/openai/codex), Apache-2.0.
 * See LICENSE and NOTICE in this directory.
 *
 * @module
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Prompt sent into the session to generate the AGENTS.md contributor guide.
 * The model explores the repository and writes the file itself.
 */
const INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.

Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

## Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

## Recommended Sections

### Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

### Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

### Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

### Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

### Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project's Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

### Optional

Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`;

/**
 * Registers the `/init` command.
 *
 * Skips with a warning when AGENTS.md already exists; otherwise sends
 * {@link INIT_PROMPT} into the session (as a follow-up message when the
 * agent is still running), appending any extra command arguments as
 * additional user instructions.
 *
 * @param pi - Extension API used to register the command and send messages.
 */
export function registerInitCommand(pi: ExtensionAPI): void {
  pi.registerCommand('init', {
    description: 'Create an AGENTS.md file with instructions for pi',
    handler: async (args, ctx) => {
      const agentsPath = join(ctx.cwd, 'AGENTS.md');
      try {
        await access(agentsPath);
        if (ctx.hasUI) ctx.ui.notify('AGENTS.md already exists; not overwriting it', 'warning');
        return;
      } catch {
        // not found — proceed
      }

      const extra = args.trim();
      const prompt =
        extra.length > 0 ? `${INIT_PROMPT}\n\nAdditional user instructions: ${extra}` : INIT_PROMPT;
      pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: 'followUp' });
    },
  });
}
