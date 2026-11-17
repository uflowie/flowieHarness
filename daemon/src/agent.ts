// What a workspace's agent runs with: pi-durable's coding tools, code mode and tool search, and pi's coding-agent
// system prompt, minus the sections about pi itself (its docs, PI_* variables) that do not apply to flowie.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import {
	createRegistry,
	defineExtension,
	GenerationTask,
	hook,
	type PromptInput,
	section,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { formatSkillsForPrompt, loadSkills } from "./skills.ts";

// The text below follows pi/packages/coding-agent/src/core/system-prompt.ts, with each tool's snippet and guidelines
// from coding-agent/src/core/tools/*.ts and coding-agent/src/extensions/{codemode,tool-search}/tool.ts.
const PREAMBLE =
	"You are a coding assistant running inside flowie, a coding agent harness. Help users inspect files, run commands, and modify code.";

/** pi's one-line snippet (listed under `tools`) and guidelines (under `rules`) per tool. */
const TOOL_PROMPTS: Readonly<Record<string, { readonly snippet: string; readonly guidelines: readonly string[] }>> = {
	read: { snippet: "Read file contents", guidelines: ["Use read to examine files instead of cat or sed."] },
	bash: { snippet: "Execute bash commands (ls, grep, find, etc.)", guidelines: [] },
	powershell: { snippet: "Execute PowerShell commands", guidelines: [] },
	edit: {
		snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		guidelines: [
			"Use edit for targeted changes. Batch changes to one file in a single call.",
			"Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
		],
	},
	write: { snippet: "Create or overwrite files", guidelines: ["Use write only for new files or complete rewrites."] },
	codemode: {
		snippet: "Run JavaScript that calls other tools",
		guidelines: [
			"Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.",
		],
	},
	tool_search: { snippet: "Search for tools that are not loaded yet and load the matches", guidelines: [] },
};

/** flowie's own rule: the web UI shows images the answer links by worktree path. */
const IMAGE_RULE =
	"To show the user an image file from the worktree, link it in Markdown by its path, e.g. ![chart](out/chart.png).";

/** pi's context file names; the first one present in a directory is the one read. */
export const INSTRUCTION_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/**
 * The registry every workspace's Harness reads: the coding tools, code mode (scripts run in `sandbox`, which the caller
 * closes), tool search, and flowie's prompt.
 */
export function createAgentRegistry(agentDir: string, sandbox: CodemodeSandboxBase) {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(createCodemodeExtension({ sandbox }));
	registry.install(createToolSearchExtension());
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
			section("tools", (input) => toolList(input)),
			section("rules", (input) => rules(input)),
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

/** The offered tools that have a snippet, as pi lists them. */
function toolList(input: PromptInput): string {
	const listed = input.agent.tools.filter((tool) => TOOL_PROMPTS[tool.name] !== undefined);
	const lines = listed.map((tool) => `- ${tool.name}: ${TOOL_PROMPTS[tool.name]!.snippet}`);
	return `${lines.length ? lines.join("\n") : "(none)"}\n\nAdditional tools may be available.`;
}

/** pi's rules (`buildRules`) for the offered tools, with flowie's image rule before pi's closing two. */
function rules(input: PromptInput): string {
	const names = new Set(input.agent.tools.map((tool) => tool.name));
	const shell = names.has("bash") || names.has("powershell");
	const fileTools = names.has("grep") || names.has("find") || names.has("ls");
	const shellRule =
		!shell || fileTools
			? []
			: names.has("bash") && names.has("powershell")
				? ["Use bash or PowerShell for file operations like listing, searching, and finding files"]
				: names.has("powershell")
					? ["Use PowerShell for file operations like listing, searching, and finding files"]
					: ["Use bash for file operations like ls, rg, find"];
	const all = [
		...shellRule,
		...input.agent.tools.flatMap((tool) => TOOL_PROMPTS[tool.name]?.guidelines ?? []),
		IMAGE_RULE,
		"Be concise in your responses",
		"Show file paths clearly when working with files",
	];
	return [...new Set(all)].map((rule) => `- ${rule}`).join("\n");
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
