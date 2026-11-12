// A fake model for working on the UI without spending tokens (`FLOWIE_FAKE=1`). It streams thinking and Markdown, and
// runs a real `bash` call when the message mentions "bash" or "tool", writes three pages for "long" or "lorem", and
// for "slow" waits a second and streams unreadable thinking before answering.
// Tools act on real files.
import type { Message } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxResponseFactory,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentDefaults } from "./models.ts";

export const FAKE_DEFAULTS: AgentDefaults = { model: { provider: "fake", modelId: "fake" }, thinkingLevel: "medium" };

export function createFakeModels(): MutableModels {
	const faux = fauxProvider({
		provider: "fake",
		models: [{ id: "fake", name: "Fake model", reasoning: true, input: ["text", "image"] }],
		tokensPerSecond: 150,
	});
	// The faux provider consumes one scripted step per request: each answer schedules the next.
	const respond: FauxResponseFactory = async (context) => {
		faux.appendResponses([respond]);
		// "slow" in the user's message holds the first token back, then streams thinking with nothing readable in it,
		// like an OpenAI model whose reasoning stays encrypted.
		const slow = /\bslow\b/i.test(userText(context.messages.findLast((message) => message.role === "user")));
		if (!slow) return reply(context.messages);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const answer = reply(context.messages);
		return { ...answer, content: [fauxThinking(" ".repeat(1_500)), ...answer.content] };
	};
	faux.setResponses([respond]);
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

function reply(messages: readonly Message[]) {
	const last = messages.at(-1);
	if (last?.role === "toolResult") {
		const output = last.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
		return fauxAssistantMessage([
			fauxThinking("The command ran; summarizing its output for the user."),
			fauxText(`The command finished${last.isError ? " **with an error**" : ""}. Its output:\n\n\`\`\`\n${output.trim() || "(no output)"}\n\`\`\`\n\nAnything else?`),
		]);
	}
	const text = userText(last);
	if (/\b(long|lorem)\b/i.test(text))
		return fauxAssistantMessage([fauxThinking("A long answer, to exercise streaming and scrolling."), fauxText(LONG)]);
	if (/\b(bash|tool)\b/i.test(text))
		return fauxAssistantMessage(
			[
				fauxThinking("The user wants to see a tool call. I will run a harmless git command in the worktree."),
				fauxText("Let me look at the worktree."),
				fauxToolCall("bash", { command: "git status --short --branch && git log --oneline -5" }),
			],
			{ stopReason: "toolUse" },
		);
	return fauxAssistantMessage([
		fauxThinking(`Considering how to answer: "${text.slice(0, 80)}"`),
		fauxText(
			`You said:\n\n> ${text.replaceAll("\n", "\n> ") || "(an image)"}\n\nThis is the **fake model**. It renders Markdown, for example a list:\n\n- item one\n- item \`two\`\n\nand code:\n\n\`\`\`ts\nconst answer: number = 42;\nconsole.log(\`answer: \${answer}\`);\n\`\`\`\n\nMention *bash* to see a tool call.`,
		),
	]);
}

function userText(message: Message | undefined): string {
	if (message?.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** About three pages, numbered so a repeated or lost paragraph is easy to spot. */
const LONG = Array.from(
	{ length: 18 },
	(_, index) =>
		`Paragraph ${index + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.`,
).join("\n\n");
