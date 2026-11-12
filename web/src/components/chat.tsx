// The chat with a workspace's agent (the AI Elements Chat pattern): the transcript in a Message Scroller that follows
// the streaming answer while the reader is at the bottom, then the prompt input. No row is a `scrollAnchor`: the
// scroller jumps to anchors even when the reader scrolled away (and to unseen older ones when a row is replaced, as
// the streaming answer is by its committed entry), and the reader's own scrolling must win.
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, InboxState, LiveState, ToolSlot } from "@earendil-works/pi-durable";
import { AlertCircleIcon, LoaderCircleIcon, MessageCircleDashedIcon, RotateCwIcon, SquareIcon } from "lucide-react";
import type { TranscriptView } from "pi-durable-transcript";
import { Fragment, type ReactNode } from "react";
import { toast } from "sonner";
import { ReasoningStep, ToolStep } from "@/components/agent-steps";
import { Markdown } from "@/components/markdown";
import { PromptInput } from "@/components/prompt-input";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import type { ConversationState } from "@/hooks/use-conversation";
import { type Pending, useOutbox } from "@/hooks/use-outbox";
import { api } from "@/lib/api";
import { CurrentWorkspace } from "@/lib/workspace-images";

type Props = { readonly workspace: string; readonly conversation: ConversationState };

/** Tool results and running tool slots by call ID, so each call's line shows its outcome. */
type Calls = { readonly results: Map<string, ToolResultMessage>; readonly slots: Map<string, ToolSlot> };

export function Chat({ workspace, conversation }: Props) {
	const { view, problem } = conversation;
	const live = view?.docs["pi.live"] as LiveState | undefined;
	const busy = live?.run !== undefined;
	const streaming = live?.generation?.message as AssistantMessage | undefined;
	const outbox = useOutbox(workspace, view);
	const empty =
		view !== undefined &&
		!streaming &&
		outbox.pending.length === 0 &&
		!view.items.some((item) => item.kind === "entry");

	return (
		<CurrentWorkspace.Provider value={workspace}>
			<MessageScrollerProvider autoScroll>
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="min-h-0 flex-1">
						{view === undefined ? (
							<Empty className="h-full">
								<Spinner />
							</Empty>
						) : empty ? (
							<Empty className="h-full">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<MessageCircleDashedIcon />
									</EmptyMedia>
									<EmptyTitle>What should we build?</EmptyTitle>
									<EmptyDescription>The agent works in this worktree: it reads code, runs commands and edits files.</EmptyDescription>
								</EmptyHeader>
							</Empty>
						) : (
							<MessageScroller>
								<MessageScrollerViewport>
									<MessageScrollerContent aria-busy={busy} className="mx-auto w-full max-w-3xl gap-6 px-6 py-6">
										<Transcript workspace={workspace} view={view} conversation={conversation} pending={outbox.pending} />
									</MessageScrollerContent>
								</MessageScrollerViewport>
								<MessageScrollerButton />
							</MessageScroller>
						)}
					</div>
					<div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 pb-6">
						{problem && (
							<Marker className="text-destructive">
								<MarkerIcon>
									<AlertCircleIcon />
								</MarkerIcon>
								<MarkerContent>{problem}</MarkerContent>
							</Marker>
						)}
						<PromptInput workspace={workspace} busy={busy} view={view} send={outbox.send} />
					</div>
				</div>
			</MessageScrollerProvider>
		</CurrentWorkspace.Provider>
	);
}

type TranscriptProps = {
	readonly workspace: string;
	readonly view: TranscriptView;
	readonly conversation: ConversationState;
	readonly pending: readonly Pending[];
};

function Transcript({ workspace, view, conversation, pending }: TranscriptProps) {
	const live = view.docs["pi.live"] as LiveState | undefined;
	const inbox = view.docs["pi.inbox"] as InboxState | undefined;
	const streaming = live?.generation?.message as AssistantMessage | undefined;
	const calls: Calls = { results: new Map(), slots: new Map((live?.tools ?? []).map((slot) => [slot.callId, slot])) };
	for (const item of view.items) {
		const message = item.kind === "entry" ? item.entry.model?.[0] : undefined;
		if (message?.role === "toolResult") calls.results.set(message.toolCallId, message);
	}

	return (
		<>
			{view.items.map((item) => {
				switch (item.kind) {
					case "earlier":
						return (
							<MessageScrollerItem key="earlier" messageId="earlier" className="flex justify-center">
								<Button variant="ghost" size="sm" onClick={conversation.loadEarlier}>
									Load earlier messages
								</Button>
							</MessageScrollerItem>
						);
					case "gap":
						return (
							<MessageScrollerItem key={`gap-${item.after}`} messageId={`gap-${item.after}`} className="flex justify-center">
								<Button variant="ghost" size="sm" onClick={() => conversation.fillGap(item)}>
									Load missing messages
								</Button>
							</MessageScrollerItem>
						);
					case "entry": {
						const content = entryContent(item.entry, calls);
						return content === null ? null : (
							<MessageScrollerItem key={item.entry.id} messageId={String(item.entry.id)}>
								{content}
							</MessageScrollerItem>
						);
					}
				}
			})}
			{streaming && shows(streaming) && (
				<MessageScrollerItem messageId="streaming">
					<Assistant message={streaming} calls={calls} streaming />
				</MessageScrollerItem>
			)}
			{live?.generation?.retry && (
				<MessageScrollerItem messageId="retry">
					<Marker>
						<MarkerIcon>
							<RotateCwIcon />
						</MarkerIcon>
						<MarkerContent>
							Retrying {relativeTime(live.generation.retry.at)}: {live.generation.retry.error}
						</MarkerContent>
					</Marker>
				</MessageScrollerItem>
			)}
			{live?.compactions?.map((compaction) => (
				<MessageScrollerItem key={compaction.taskId} messageId={`compaction-${compaction.taskId}`}>
					<Marker>
						<MarkerIcon>
							<Spinner />
						</MarkerIcon>
						<MarkerContent>Compacting context</MarkerContent>
					</Marker>
				</MessageScrollerItem>
			))}
			{inbox?.items.map((queued) =>
				queued.mode === "write" ? null : (
					<MessageScrollerItem key={queued.id} messageId={`queued-${queued.id}`}>
						<Message align="end">
							<MessageContent>
								<Bubble align="end" variant="outline">
									<BubbleContent>
										<UserContent content={queued.content as UserMessage["content"]} />
									</BubbleContent>
								</Bubble>
								<MessageFooter>{queued.mode === "steer" ? "Steering the current run" : "Queued for after this run"}</MessageFooter>
							</MessageContent>
						</Message>
					</MessageScrollerItem>
				),
			)}
			{pending.map((each) => (
				<MessageScrollerItem key={each.key} messageId={`pending-${each.key}`}>
					<Message align="end">
						<MessageContent>
							<Bubble align="end" variant="muted" className="opacity-70">
								<BubbleContent>
									<UserContent content={each.content} />
								</BubbleContent>
							</Bubble>
							<MessageFooter>Sending…</MessageFooter>
						</MessageContent>
					</Message>
				</MessageScrollerItem>
			))}
			{working(live, streaming, pending) && (
				<MessageScrollerItem messageId="working">
					<TraceLine status="running">
						<TraceIcon>
							<LoaderCircleIcon className="animate-spin" />
						</TraceIcon>
						<TraceTitle>Working</TraceTitle>
					</TraceLine>
				</MessageScrollerItem>
			)}
			{live?.run === undefined && live?.runFailure && failureShown(live.runFailure.reason) && (
				<MessageScrollerItem messageId="run-failure">
					<Item variant="outline" size="sm">
						<ItemMedia variant="icon">
							<AlertCircleIcon className="text-destructive" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>The run ended without an answer</ItemTitle>
							<ItemDescription>
								{live.runFailure.reason.replaceAll("_", " ")}
								{live.runFailure.detail ? `: ${live.runFailure.detail}` : ""}
							</ItemDescription>
						</ItemContent>
						{live.runFailure.reason !== "no_model" && (
							<ItemActions>
								<Button
									size="sm"
									variant="outline"
									onClick={() => api.continue(workspace).catch((error: unknown) => toast.error(String(error)))}
								>
									Continue
								</Button>
							</ItemActions>
						)}
					</Item>
				</MessageScrollerItem>
			)}
		</>
	);
}

/**
 * Whether to show "Working": something was sent or a run is going, but nothing shows progress yet (no answer streaming
 * visibly, no tool running, no retry or compaction notice), as before the first token or between a tool and the next
 * answer.
 */
function working(live: LiveState | undefined, streaming: AssistantMessage | undefined, pending: readonly Pending[]): boolean {
	if (live?.run === undefined && pending.length === 0) return false;
	if (live?.generation?.retry || live?.compactions?.length) return false;
	if (live?.tools?.some((slot) => slot.status !== "done")) return false;
	return streaming === undefined || !shows(streaming);
}

/**
 * Whether a streaming answer has anything to show yet. It often starts as an empty thinking block (OpenAI's reasoning
 * stays encrypted); rendered then, its empty row would take a gap in the transcript and push "Working" down.
 */
function shows(message: AssistantMessage): boolean {
	return message.content.some((part) =>
		part.type === "text" ? part.text.trim() !== "" : part.type === "thinking" ? part.thinking.trim() !== "" : true,
	);
}

/** Aborts and resets are the user's own doing; every other way a run ends without an answer is shown. */
const failureShown = (reason: string) => reason !== "aborted" && reason !== "reset";

function entryContent(entry: EntryRecord, calls: Calls): ReactNode {
	const message = entry.model?.[0];
	switch (entry.kind) {
		case "pi.system":
		case "pi.tool-result":
			// System prompt updates are bookkeeping; results show on their call's line.
			return null;
		case "pi.compaction":
			return <Divider label="Context compacted" detail={entry.data} />;
		case "pi.reset":
			return <Divider label="New context" detail={entry.data} />;
	}
	if (message?.role === "user")
		return (
			<Message align="end">
				<MessageContent>
					<Bubble align="end" variant="muted">
						<BubbleContent>
							<UserContent content={message.content} />
						</BubbleContent>
					</Bubble>
				</MessageContent>
			</Message>
		);
	if (message?.role === "assistant") return <Assistant message={message} calls={calls} />;
	return <Divider label={entry.kind} detail={entry.data} />;
}

function UserContent({ content }: { content: UserMessage["content"] }) {
	if (typeof content === "string") return <div className="whitespace-pre-wrap">{content}</div>;
	return (
		<div className="flex flex-col gap-2">
			{content.map((part, index) =>
				part.type === "text" ? (
					<div key={index} className="whitespace-pre-wrap">
						{part.text}
					</div>
				) : (
					<img
						key={index}
						className="max-h-64 w-fit rounded-lg"
						src={`data:${part.mimeType};base64,${part.data}`}
						alt=""
					/>
				),
			)}
		</div>
	);
}

/**
 * One model response: runs of thinking and tool calls as a Trace, text as Markdown, in the order the model produced
 * them.
 */
function Assistant({ message, calls, streaming = false }: { message: AssistantMessage; calls: Calls; streaming?: boolean }) {
	const groups: { kind: "steps" | "text"; parts: AssistantMessage["content"] }[] = [];
	for (const part of message.content) {
		const kind = part.type === "text" ? "text" : "steps";
		if (part.type === "thinking" && !part.thinking.trim()) continue;
		const last = groups.at(-1);
		if (last?.kind === kind && kind === "steps") last.parts.push(part);
		else groups.push({ kind, parts: [part] });
	}
	const lastPart = message.content.at(-1);
	return (
		<Message>
			<MessageContent className="gap-3">
				{groups.map((group, index) =>
					group.kind === "text" ? (
						<Fragment key={index}>
							{group.parts.map((part, at) =>
								part.type === "text" ? (
									<Markdown key={at} text={part.text} streaming={streaming && part === lastPart} />
								) : null,
							)}
						</Fragment>
					) : (
						<Trace key={index}>
							{group.parts.map((part, at) =>
								part.type === "thinking" ? (
									<ReasoningStep key={at} text={part.thinking} running={streaming && part === lastPart} />
								) : part.type === "toolCall" ? (
									<ToolStep
										key={part.id}
										call={part}
										result={calls.results.get(part.id)}
										slot={calls.slots.get(part.id)}
										streaming={streaming}
									/>
								) : null,
							)}
						</Trace>
					),
				)}
				{message.stopReason === "error" && (
					<Marker className="text-destructive">
						<MarkerIcon>
							<AlertCircleIcon />
						</MarkerIcon>
						<MarkerContent>{message.errorMessage ?? "The model failed"}</MarkerContent>
					</Marker>
				)}
				{message.stopReason === "aborted" && !streaming && (
					<Marker>
						<MarkerIcon>
							<SquareIcon />
						</MarkerIcon>
						<MarkerContent>Stopped</MarkerContent>
					</Marker>
				)}
			</MessageContent>
		</Message>
	);
}

function Divider({ label, detail }: { label: string; detail: unknown }) {
	const text = detailText(detail);
	if (!text)
		return (
			<Marker variant="separator">
				<MarkerContent>{label}</MarkerContent>
			</Marker>
		);
	return (
		<Collapsible>
			<CollapsibleTrigger render={<Marker variant="separator" render={<button type="button" />} />}>
				<MarkerContent>{label}</MarkerContent>
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2 rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap text-muted-foreground">
				{text}
			</CollapsibleContent>
		</Collapsible>
	);
}

function detailText(detail: unknown): string | undefined {
	if (detail === undefined || detail === null) return undefined;
	if (typeof detail === "string") return detail;
	const summary = (detail as { summary?: unknown }).summary;
	return typeof summary === "string" ? summary : JSON.stringify(detail, null, 2);
}

function relativeTime(at: number): string {
	const seconds = Math.max(0, Math.round((at - Date.now()) / 1000));
	return seconds === 0 ? "now" : `in ${seconds}s`;
}
