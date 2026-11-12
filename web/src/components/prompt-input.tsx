// Where the user writes to the agent (the AI Elements Prompt Input pattern): text plus images pasted, dropped or
// attached, the model and thinking level, and while the agent works: queue or steer, and stop.
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentState } from "@earendil-works/pi-durable";
import type { ModelListing, Submit } from "@flowie/daemon/protocol";
import { ArrowUpIcon, BrainIcon, ChevronDownIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";
import type { TranscriptView } from "pi-durable-transcript";
import { type ClipboardEvent, type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	Attachment,
	AttachmentAction,
	AttachmentActions,
	AttachmentContent,
	AttachmentMedia,
	AttachmentTitle,
} from "@/components/ui/attachment";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { useMessageScroller } from "@/components/ui/message-scroller";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type Image = { readonly id: string; readonly name: string; readonly data: string; readonly mimeType: string; readonly url: string };

type Props = {
	readonly workspace: string;
	readonly busy: boolean;
	readonly view: TranscriptView | undefined;
	/** Shows the message at once and submits it (the outbox); rejects when the daemon refuses it. */
	send(draft: Submit): Promise<void>;
};

export function PromptInput({ workspace, busy, view, send: submit }: Props) {
	const [text, setText] = useState(() => readDraft(workspace));
	const [images, setImages] = useState<Image[]>([]);
	const [mode, setMode] = useState<"followUp" | "steer">("followUp");
	const [dragging, setDragging] = useState(false);
	const textarea = useRef<HTMLTextAreaElement>(null);
	const picker = useRef<HTMLInputElement>(null);
	const scroller = useMessageScroller();
	const canSend = text.trim().length > 0 || images.length > 0;

	useEffect(() => {
		try {
			if (text) localStorage.setItem(draftKey(workspace), text);
			else localStorage.removeItem(draftKey(workspace));
		} catch {
			// Drafts are a convenience.
		}
	}, [workspace, text]);

	useEffect(() => textarea.current?.focus(), []);

	const addFiles = async (files: Iterable<File>) => {
		const added = await Promise.all([...files].filter((file) => file.type.startsWith("image/")).map(readImage));
		if (added.length) setImages((current) => [...current, ...added]);
	};

	const send = async (event?: FormEvent) => {
		event?.preventDefault();
		if (!canSend) return;
		const trimmed = text.trim();
		const sent = { text, images };
		// The message shows in the transcript at once; the composer is free for the next one.
		setText("");
		setImages([]);
		// Sending is the user's own move: show the new turn and follow the answer again.
		scroller.scrollToEnd({ behavior: "smooth" });
		textarea.current?.focus();
		try {
			await submit({
				content: sent.images.length
					? [
							...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
							...sent.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })),
						]
					: trimmed,
				whenBusy: mode,
				requestId: crypto.randomUUID(),
			});
		} catch (error) {
			// Refused: back into the composer, unless the user already wrote the next message.
			setText((current) => current || sent.text);
			setImages((current) => (current.length ? current : sent.images));
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};

	const stop = () => api.abort(workspace).catch((error: unknown) => toast.error(String(error)));

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void send();
		}
		if (event.key === "Escape" && busy) void stop();
	};

	const onPaste = (event: ClipboardEvent) => {
		const files = [...event.clipboardData.files];
		if (!files.some((file) => file.type.startsWith("image/"))) return;
		event.preventDefault();
		void addFiles(files);
	};

	return (
		<form onSubmit={(event) => void send(event)}>
			<input
				ref={picker}
				type="file"
				accept="image/*"
				multiple
				className="sr-only"
				tabIndex={-1}
				onChange={(event) => {
					if (event.target.files) void addFiles(event.target.files);
					event.target.value = "";
				}}
			/>
			<InputGroup
				className={cn("rounded-xl bg-card", dragging && "border-ring border-dashed")}
				onDragOver={(event) => {
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={(event) => {
					event.preventDefault();
					setDragging(false);
					void addFiles(event.dataTransfer.files);
				}}
			>
				{images.length > 0 && (
					<InputGroupAddon align="block-start" className="flex-wrap">
						{images.map((image) => (
							<Attachment key={image.id} size="sm">
								<AttachmentMedia variant="image">
									<img src={image.url} alt="" />
								</AttachmentMedia>
								<AttachmentContent>
									<AttachmentTitle>{image.name}</AttachmentTitle>
								</AttachmentContent>
								<AttachmentActions>
									<AttachmentAction
										aria-label={`Remove ${image.name}`}
										onClick={() => setImages((current) => current.filter((each) => each !== image))}
									>
										<XIcon />
									</AttachmentAction>
								</AttachmentActions>
							</Attachment>
						))}
					</InputGroupAddon>
				)}
				<InputGroupTextarea
					ref={textarea}
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					placeholder={busy ? "Message the agent while it works…" : "Ask the agent…"}
					aria-label="Message"
					className="max-h-64 min-h-14 px-3 pt-3"
				/>
				<InputGroupAddon align="block-end" className="gap-1">
					<Tooltip>
						<TooltipTrigger
							render={
								<InputGroupButton size="icon-sm" aria-label="Attach images" onClick={() => picker.current?.click()} />
							}
						>
							<PaperclipIcon />
						</TooltipTrigger>
						<TooltipContent>Attach images (or paste / drop them)</TooltipContent>
					</Tooltip>
					{view && <ModelSelector workspace={workspace} view={view} />}
					<div className="ml-auto flex items-center gap-1">
						{busy && (
							<ToggleGroup
								size="sm"
								variant="outline"
								spacing={0}
								className="*:aria-pressed:bg-secondary *:aria-pressed:text-foreground"
								value={[mode]}
								onValueChange={(value: string[]) => {
									const next = value[0];
									if (next === "followUp" || next === "steer") setMode(next);
								}}
							>
								<ToggleGroupItem value="followUp" aria-label="Queue for after this run">
									Queue
								</ToggleGroupItem>
								<ToggleGroupItem value="steer" aria-label="Steer the current run">
									Steer
								</ToggleGroupItem>
							</ToggleGroup>
						)}
						{busy && (
							<Tooltip>
								<TooltipTrigger
									render={<InputGroupButton size="icon-sm" variant="outline" aria-label="Stop" onClick={() => void stop()} />}
								>
									<SquareIcon />
								</TooltipTrigger>
								<TooltipContent>Stop (Esc)</TooltipContent>
							</Tooltip>
						)}
						<InputGroupButton type="submit" variant="default" size="icon-sm" disabled={!canSend} aria-label="Send">
							<ArrowUpIcon />
						</InputGroupButton>
					</div>
				</InputGroupAddon>
			</InputGroup>
		</form>
	);
}

const THINKING: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

let modelsRequest: Promise<ModelListing> | undefined;

/** The agent's model (searchable, by provider) and thinking level, as the AI Elements Model Selector. */
function ModelSelector({ workspace, view }: { workspace: string; view: TranscriptView }) {
	const [listing, setListing] = useState<ModelListing>();
	const [open, setOpen] = useState(false);
	useEffect(() => {
		modelsRequest ??= api.models();
		modelsRequest.then(setListing, (error: unknown) => {
			modelsRequest = undefined;
			toast.error(`Models: ${String(error)}`);
		});
	}, []);
	const agent = view.docs["pi.agent"] as AgentState | undefined;
	const model = agent?.model ?? listing?.defaults.model;
	const current = model ? `${model.provider}/${model.modelId}` : undefined;
	const info = listing?.models.find((each) => `${each.provider}/${each.id}` === current);
	const thinking = agent?.thinkingLevel ?? listing?.defaults.thinkingLevel ?? "off";
	const providers = [...new Set(listing?.models.map((each) => each.provider))];
	const configure = (change: Parameters<typeof api.configure>[1]) =>
		api.configure(workspace, change).catch((error: unknown) => toast.error(String(error)));

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger
					render={
						<InputGroupButton
							size="sm"
							className={cn(!current && "text-destructive")}
							aria-label={info ? `Model: ${info.name}` : "Pick a model"}
						/>
					}
				>
					{info?.name ?? (current ? `${current} (unavailable)` : "Pick a model")}
					<ChevronDownIcon />
				</PopoverTrigger>
				<PopoverContent align="start" side="top" className="w-72 p-0">
					<Command>
						<CommandInput placeholder="Search models" />
						<CommandList>
							<CommandEmpty>No model found.</CommandEmpty>
							{providers.map((provider) => (
								<CommandGroup key={provider} heading={provider}>
									{listing?.models
										.filter((each) => each.provider === provider)
										.map((each) => {
											const id = `${each.provider}/${each.id}`;
											return (
												<CommandItem
													key={id}
													data-checked={id === current}
													value={`${id} ${each.name}`}
													onSelect={() => {
														setOpen(false);
														void configure({ model: { provider: each.provider, modelId: each.id } });
													}}
												>
													<span className="truncate">{each.name}</span>
												</CommandItem>
											);
										})}
								</CommandGroup>
							))}
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
			{info?.reasoning && (
				<DropdownMenu>
					<DropdownMenuTrigger render={<InputGroupButton size="sm" aria-label={`Thinking: ${thinking}`} />}>
						<BrainIcon />
						{thinking}
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" side="top" className="w-40">
						<DropdownMenuGroup>
							<DropdownMenuLabel>Thinking</DropdownMenuLabel>
							<DropdownMenuRadioGroup
								value={thinking}
								onValueChange={(value: string) => void configure({ thinkingLevel: value as ModelThinkingLevel })}
							>
								{THINKING.map((level) => (
									<DropdownMenuRadioItem key={level} value={level}>
										{level}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</>
	);
}

const draftKey = (workspace: string) => `flowie.draft.${workspace}`;

function readDraft(workspace: string): string {
	try {
		return localStorage.getItem(draftKey(workspace)) ?? "";
	} catch {
		return "";
	}
}

function readImage(file: File): Promise<Image> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error);
		reader.onload = () => {
			const url = String(reader.result);
			resolve({ id: crypto.randomUUID(), name: file.name || "image", url, mimeType: file.type, data: url.slice(url.indexOf(",") + 1) });
		};
		reader.readAsDataURL(file);
	});
}
