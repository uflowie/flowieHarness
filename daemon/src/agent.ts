// What a workspace's agent runs with: pi-durable's coding tools and flowie's system prompt.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
	createRegistry,
	defineExtension,
	GenerationTask,
	hook,
	type PromptInput,
	section,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const PREAMBLE = `You are a coding agent working in a git worktree on the user's machine, driven from the flowie web UI.
Use the tools to read, search, edit and run code. Prefer small, verifiable steps; run the project's checks after edits.
Keep answers short and concrete. Never print, commit or publish credentials.
To show the user an image file from the worktree, link it in Markdown by its path, e.g. ![chart](out/chart.png).`;

/** Instruction files read from the agent directory and from the worktree, in this order. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

/** The registry every workspace's Harness reads: the coding tools and flowie's prompt. */
export function createAgentRegistry(agentDir: string) {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(flowiePrompt(agentDir));
	return registry;
}

/**
 * The system prompt sections. Sections render before every request, but Durable only resends what changed, so the
 * instruction files are read each time and an edit reaches the next request without a restart.
 */
function flowiePrompt(agentDir: string) {
	return defineExtension({
		name: "flowie",
		hooks: [hook(GenerationTask, { beforeProviderRequest: (request) => detailedReasoningSummaries(request) })],
		sections: [
			section("preamble", () => PREAMBLE, { tag: false }),
			section("environment", (input) => environment(input)),
			section("user_instructions", (input, context) => instructions(input.env, [agentDir], context)),
			section("project_instructions", (input, context) =>
				input.env === undefined ? undefined : instructions(input.env, [input.env.cwd], context),
			),
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

function environment(input: PromptInput): string | undefined {
	if (input.env === undefined) return undefined;
	return `Working directory: ${input.env.cwd}\nPlatform: ${process.platform}`;
}

/** The instruction files found in `directories`, each under its path; undefined when there are none. */
async function instructions(
	env: ExecutionEnv | undefined,
	directories: readonly string[],
	context: Context,
): Promise<string | undefined> {
	if (env === undefined) return undefined;
	const found: string[] = [];
	for (const directory of directories)
		for (const name of INSTRUCTION_FILES) {
			const path = join(directory, name);
			const read = await env.readTextFile(path, context);
			if (read.ok && read.value.trim()) found.push(`# ${path}\n\n${read.value.trim()}`);
		}
	return found.length ? found.join("\n\n") : undefined;
}
