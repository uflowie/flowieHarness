// What a workspace's agent runs with: pi-durable's coding tools and pi's coding-agent system prompt, minus the
// sections about pi itself (its docs, PI_* variables) that do not apply to flowie.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
	createRegistry,
	defineExtension,
	GenerationTask,
	hook,
	section,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { formatSkillsForPrompt, loadSkills } from "./skills.ts";

// The text below follows pi/packages/coding-agent/src/core/system-prompt.ts with the default tools (read, bash,
// edit, write) and each tool's snippet and guidelines from coding-agent/src/core/tools/*.ts.
const PREAMBLE =
	"You are a coding assistant running inside flowie, a coding agent harness. Help users inspect files, run commands, and modify code.";

const TOOLS = `- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

Additional tools may be available.`;

const RULES = `- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Use edit for targeted changes. Batch changes to one file in a single call.
- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.
- Use write only for new files or complete rewrites.
- To show the user an image file from the worktree, link it in Markdown by its path, e.g. ![chart](out/chart.png).
- Be concise in your responses
- Show file paths clearly when working with files`;

/** pi's context file names; the first one present in a directory is the one read. */
export const INSTRUCTION_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** The registry every workspace's Harness reads: the coding tools and flowie's prompt. */
export function createAgentRegistry(agentDir: string) {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(flowiePrompt(agentDir));
	return registry;
}

/**
 * The system prompt sections. Sections render before every request, but Durable only resends what changed, so the
 * instruction files and skills are read each time and an edit reaches the next request without a restart.
 */
function flowiePrompt(agentDir: string) {
	return defineExtension({
		name: "flowie",
		hooks: [hook(GenerationTask, { beforeProviderRequest: (request) => detailedReasoningSummaries(request) })],
		sections: [
			section("preamble", () => PREAMBLE, { tag: false }),
			section("tools", () => TOOLS),
			section("rules", () => RULES),
			section("project_context", (input, context) =>
				input.env === undefined ? undefined : projectContext(input.env, [agentDir, input.env.cwd], context),
			),
			section("skills", async (input) =>
				input.env === undefined ? undefined : formatSkillsForPrompt(await loadSkills(agentDir, input.env.cwd)),
			),
			section("cwd",(input) => input.env?.cwd.replace(/\\/g, "/")),
		],
	});
}

/** The OpenAI Responses APIs, whose readable thinking comes as reasoning summaries the request asks for. */
const RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"]);

/**
 * Asks OpenAI Responses models for detailed reasoning summaries. pi-ai sends `summary: "auto"`, with which the model
 * often summarizes nothing (its reasoning stays encrypted), so the UI had no thinking to show before the answer.
 */
export function detailedReasoningSummaries(request: {
	readonly model: { readonly api: string };
	readonly payload: unknown;
}) {
	if (!RESPONSES_APIS.has(request.model.api)) return undefined;
	// Trust boundary: the body pi-ai built for this provider, typed `unknown`.
	const payload = request.payload as { reasoning?: { summary?: unknown } } | null;
	if (payload?.reasoning?.summary !== "auto") return undefined;
	return { payload: { ...payload, reasoning: { ...payload.reasoning, summary: "detailed" } } };
}

/** The first instruction file of each directory, rendered as pi renders project context; undefined when there are none. */
async function projectContext(
	env: ExecutionEnv,
	directories: readonly string[],
	context: Context,
): Promise<string | undefined> {
	const found: string[] = [];
	for (const directory of directories)
		for (const name of INSTRUCTION_FILES) {
			const path = join(directory, name);
			const read = await env.readTextFile(path, context);
			if (!read.ok) continue;
			found.push(`<project_instructions path="${path}">\n${read.value}\n</project_instructions>`);
			break;
		}
	return found.length ? ["Project-specific instructions and guidelines:", ...found].join("\n\n") : undefined;
}
