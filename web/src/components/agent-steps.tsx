// The agent's steps between its words, as shadcn Trace rows (the AI Elements Reasoning and Tool patterns): thinking,
// and each tool call with its arguments, live output and result.
import type { ImageContent, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolSlot } from "@earendil-works/pi-durable";
import {
	CircleCheckIcon,
	FilePenIcon,
	FilePlusIcon,
	FileTextIcon,
	LoaderCircleIcon,
	type LucideIcon,
	TerminalIcon,
	WrenchIcon,
} from "lucide-react";
import { useState } from "react";
import { CodeBlock, CodeBlockContent, CodeBlockLine } from "@/components/ui/code-block";
import {
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "@/components/ui/trace";

/** Model thinking: open while it streams, then collapsed to "Thought". */
export function ReasoningStep({ text, running }: { text: string; running: boolean }) {
	const [open, setOpen] = useState<boolean>();
	return (
		<TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
			<TraceCollapsibleTrigger>
				<TraceLine status={running ? "running" : undefined}>
					<TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : <CircleCheckIcon />}</TraceIcon>
					<TraceTitle>{running ? "Thinking" : "Thought"}</TraceTitle>
				</TraceLine>
			</TraceCollapsibleTrigger>
			<TraceCollapsibleContent className="whitespace-pre-wrap">{text}</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}

type ToolKind = { readonly icon: LucideIcon; readonly running: string; readonly done: string };

const TOOLS: Record<string, ToolKind> = {
	bash: { icon: TerminalIcon, running: "Running", done: "Ran" },
	read: { icon: FileTextIcon, running: "Reading", done: "Read" },
	write: { icon: FilePlusIcon, running: "Writing", done: "Wrote" },
	edit: { icon: FilePenIcon, running: "Editing", done: "Edited" },
};

type ToolStepProps = {
	readonly call: ToolCall;
	readonly result: ToolResultMessage | undefined;
	readonly slot: ToolSlot | undefined;
	/** The call is part of the answer still streaming: it has not started yet. */
	readonly streaming: boolean;
};

/** One tool call: a line saying what it does, expanding to its arguments and output. */
export function ToolStep({ call, result, slot, streaming }: ToolStepProps) {
	const kind = TOOLS[call.name] ?? { icon: WrenchIcon, running: `Calling ${call.name}`, done: `Called ${call.name}` };
	const Icon = kind.icon;
	const failed = result?.isError === true;
	const running = result === undefined && (streaming || slot?.status === "running" || slot?.status === "pending");
	const output = result ? resultText(result) : slot?.output;
	const verb = failed ? "Failed:" : running ? kind.running : result ? kind.done : "Interrupted:";
	const images = result?.content.filter((part): part is ImageContent => part.type === "image") ?? [];
	return (
		<TraceCollapsible defaultOpen={failed}>
			<TraceCollapsibleTrigger>
				<TraceLine status={failed ? "error" : running ? "running" : undefined}>
					<TraceIcon>
						<Icon />
					</TraceIcon>
					<TraceTitle>
						{verb} <span className="font-mono text-[0.85em]">{subject(call)}</span>
					</TraceTitle>
				</TraceLine>
			</TraceCollapsibleTrigger>
			<TraceCollapsibleContent className="flex flex-col gap-2">
				<ToolArguments call={call} />
				{output ? (
					<CodeBlock size="sm" variant={failed ? "destructive" : "default"}>
						<CodeBlockContent wrap className="max-h-72">
							{output}
						</CodeBlockContent>
					</CodeBlock>
				) : null}
				{images.map((image, index) => (
					<img
						key={index}
						className="max-h-80 w-fit rounded-lg border"
						src={`data:${image.mimeType};base64,${image.data}`}
						alt=""
					/>
				))}
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}

/**
 * What the title line does not show: an edit as removed and added lines, a write's content or a code mode script as
 * code, other arguments as JSON.
 */
function ToolArguments({ call }: { call: ToolCall }) {
	const args = call.arguments as Record<string, unknown>;
	if (call.name === "edit") {
		const edits = Array.isArray(args.edits) ? (args.edits as { oldText?: unknown; newText?: unknown }[]) : [];
		if (edits.length === 0) return null;
		return (
			<CodeBlock size="sm">
				<CodeBlockContent className="max-h-72">
					{edits.flatMap((edit, index) => [
						...lines(edit.oldText).map((line, at) => (
							<CodeBlockLine key={`${index}-o${at}`} variant="removed">
								{line}
							</CodeBlockLine>
						)),
						...lines(edit.newText).map((line, at) => (
							<CodeBlockLine key={`${index}-n${at}`} variant="added">
								{line}
							</CodeBlockLine>
						)),
					])}
				</CodeBlockContent>
			</CodeBlock>
		);
	}
	const code = call.name === "write" ? args.content : call.name === "codemode" ? args.code : undefined;
	if (typeof code === "string")
		return (
			<CodeBlock size="sm">
				<CodeBlockContent className="max-h-72">{code}</CodeBlockContent>
			</CodeBlock>
		);
	const { command: _command, path: _path, ...rest } = args;
	if (Object.keys(rest).length === 0) return null;
	return (
		<CodeBlock size="sm">
			<CodeBlockContent wrap>{JSON.stringify(rest, null, 2)}</CodeBlockContent>
		</CodeBlock>
	);
}

function subject(call: ToolCall): string {
	const args = call.arguments as Record<string, unknown>;
	if (typeof args.command === "string") return args.command;
	if (typeof args.path === "string") return args.path;
	if (call.name === "tool_search" && typeof args.query === "string") return args.query;
	return "";
}

function lines(text: unknown): string[] {
	return typeof text === "string" ? text.replace(/\n$/, "").split("\n") : [];
}

function resultText(result: ToolResultMessage): string {
	return result.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
