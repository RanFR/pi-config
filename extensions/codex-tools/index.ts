/**
 * codex-tools: commands ported from the codex CLI (https://github.com/openai/codex).
 *
 * Commands:
 * - `/init` — analyze the repo and write an AGENTS.md contributor guide
 * - `/diff` — show the working-tree git diff (tracked + untracked) in a pager
 * - `/review` — review uncommitted changes, a base branch, or a commit (P0-P3 findings)
 * - `/recap` — catch-up summary of the current conversation, without compacting
 *
 * @module
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDiffCommand } from "./diff.ts";
import { registerInitCommand } from "./init.ts";
import { registerRecapCommand } from "./recap.ts";
import { registerReviewCommand } from "./review.ts";

/**
 * Extension entry point: registers the codex-derived commands.
 *
 * @param pi - Extension API used to register the commands.
 */
export default function (pi: ExtensionAPI) {
	registerInitCommand(pi);
	registerDiffCommand(pi);
	registerReviewCommand(pi);
	registerRecapCommand(pi);
}
