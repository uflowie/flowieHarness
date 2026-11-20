// The Changes tab: the worktree's changes against where it started, for review, in one virtualized scroll view (Pierre's
// CodeView) as git's line diff. Questions and change requests on lines collect here (kept in the browser) and go to the
// agent as one message. The diff loads when the tab is shown and then stays as it
// is, however the files change, until the tab is shown again or refreshed.
import type { DiffFile, WorkspaceDiff } from "@flowie/daemon/protocol";
import {
	type CodeViewItem,
	canUseWASM,
	type DiffLineAnnotation,
	type FileDiffLoadedFiles,
	type FileDiffMetadata,
	processFile,
	type SelectedLineRange,
} from "@pierre/diffs";
import { type CodeViewAnnotationArgs, CodeView, type CodeViewHandle, type CodeViewReactOptions } from "@pierre/diffs/react";
import {
	ChevronRightIcon,
	FileDiffIcon,
	MessageSquareIcon,
	PencilIcon,
	RefreshCwIcon,
	SendIcon,
	TrashIcon,
} from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import {
	type CommentKind,
	linesOf,
	loadComments,
	type ReviewComment,
	reviewMessage,
	type Side,
	saveComments,
} from "@/lib/review";
import { cn } from "@/lib/utils";

type Props = {
	readonly workspace: string;
	/** Shown: the tab is open in the selected workspace. Becoming visible loads the diff again. */
	readonly visible: boolean;
	/** The review went to the agent. */
	onSent(): void;
};

type Layout = "split" | "unified";

/** An annotation's metadata: the ID of the comment it shows, or NEW for the comment being written. */
type Note = { readonly id: string };
const NEW = "new";

/** The comment being written or edited: `id` is absent for a new one. */
type Editing = Omit<ReviewComment, "id"> & { readonly id?: string };

/** A file of the diff as the viewer shows it. Kept across refreshes while its diff is the same. */
type Entry = {
	readonly file: DiffFile;
	readonly fileDiff: FileDiffMetadata;
	readonly signature: string;
	readonly additions: number;
	readonly deletions: number;
};

const HIGHLIGHTER = canUseWASM() ? "highlights" : "shiki-js";
/** Lock files and huge diffs start collapsed. */
const LOCK_FILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/;
const LARGE_DIFF_LINES = 2000;

export function Changes({ workspace, visible, onSent }: Props) {
	const [layout, setLayout] = usePreference<Layout>("flowie.diff.layout", "split", ["split", "unified"]);
	const diff = useWorkspaceDiff(workspace, visible);
	const [comments, setComments] = useComments(workspace);
	const [editing, setEditing] = useState<Editing>();
	const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
	const [sending, setSending] = useState(false);
	const viewer = useRef<CodeViewHandle<Note, undefined>>(null);

	const entries = useEntries(diff.data);
	const byPath = useMemo(() => new Map(entries.map((entry) => [entry.file.path, entry])), [entries]);

	// A comment whose lines changed since it was written (or whose file has no changes now) is outdated: it is no
	// longer shown on a line, but is still listed and sent.
	const outdated = useMemo(() => {
		const ids = new Set<string>();
		if (!diff.data) return ids;
		for (const comment of comments) {
			const entry = byPath.get(comment.path);
			const now = entry && linesOf(entry.fileDiff, comment.side, comment.start, comment.end);
			if (!entry || (now !== undefined && now !== comment.code)) ids.add(comment.id);
		}
		return ids;
	}, [comments, byPath, diff.data]);

	const items = useItems(entries, comments, outdated, editing, toggled);

	// The viewer's callbacks read the latest state through a ref, so its options stay the same object.
	const latest = useRef({ workspace, base: diff.data?.base.commit, byPath });
	latest.current = { workspace, base: diff.data?.base.commit, byPath };

	const startComment = useCallback((path: string, range: SelectedLineRange) => {
		const entry = latest.current.byPath.get(path);
		if (!entry) return;
		const side: Side = range.endSide ?? range.side ?? "additions";
		const from = (range.side ?? "additions") === side ? range.start : range.end;
		const [start, end] = from <= range.end ? [from, range.end] : [range.end, from];
		setEditing({ path, side, start, end, kind: "change", text: "", code: linesOf(entry.fileDiff, side, start, end) ?? "" });
	}, []);

	const options = useMemo<CodeViewReactOptions<Note, undefined>>(
		() => ({
			theme: "pierre-dark",
			themeType: "dark",
			preferredHighlighter: HIGHLIGHTER,
			diffStyle: layout,
			stickyHeaders: true,
			enableGutterUtility: true,
			layout: { paddingTop: 12, paddingBottom: 96, gap: 12 },
			onGutterUtilityClick: ((range: SelectedLineRange, context: { item: CodeViewItem<Note> }) =>
				startComment(context.item.id, range)) as CodeViewReactOptions<Note, undefined>["onGutterUtilityClick"],
			loadDiffFiles: async (fileDiff): Promise<FileDiffLoadedFiles> => {
				const { workspace, base, byPath } = latest.current;
				if (base === undefined) throw new Error("No diff loaded");
				const file = byPath.get(fileDiff.name)?.file;
				const contents = await api.diffContents(workspace, base, fileDiff.name, file?.oldPath);
				if (contents.newFile === null) throw new Error(`${fileDiff.name} is gone`);
				const newFile = { name: fileDiff.name, contents: contents.newFile };
				return contents.oldFile === null
					? { oldFile: null, newFile }
					: { oldFile: { name: file?.oldPath ?? fileDiff.name, contents: contents.oldFile }, newFile };
			},
		}),
		[layout, startComment],
	);

	const commentsById = useMemo(() => new Map(comments.map((comment) => [comment.id, comment])), [comments]);

	// The gutter's + selects the lines it was dragged over; done with the comment, they are deselected.
	const stopEditing = () => {
		setEditing(undefined);
		viewer.current?.clearSelectedLines();
	};
	const save = (draft: Editing) => {
		if (draft.text.trim() === "") return;
		const saved: ReviewComment = { ...draft, id: draft.id ?? crypto.randomUUID(), text: draft.text.trim() };
		setComments(
			draft.id === undefined ? [...comments, saved] : comments.map((each) => (each.id === draft.id ? saved : each)),
		);
		stopEditing();
	};
	const remove = (id: string) => setComments(comments.filter((comment) => comment.id !== id));

	const renderAnnotation = (...[annotation]: CodeViewAnnotationArgs<Note>) => {
		const id = annotation.metadata.id;
		if (editing && (id === NEW ? editing.id === undefined : editing.id === id))
			return <CommentEditor key={editing.id ?? NEW} draft={editing} save={save} cancel={stopEditing} />;
		const comment = commentsById.get(id);
		return comment ? (
			<CommentCard comment={comment} edit={() => setEditing(comment)} remove={() => remove(comment.id)} />
		) : null;
	};

	const send = async () => {
		if (sending || comments.length === 0) return;
		setSending(true);
		try {
			await api.submit(workspace, { content: reviewMessage(comments) });
			setComments([]);
			setEditing(undefined);
			toast.success(comments.length === 1 ? "Sent the comment to the agent" : `Sent ${comments.length} comments to the agent`);
			onSent();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setSending(false);
		}
	};

	const jump = (comment: ReviewComment) =>
		viewer.current?.scrollTo({
			type: "line",
			id: comment.path,
			lineNumber: comment.end,
			side: comment.side,
			align: "center",
			behavior: "smooth-auto",
		});

	const totals = entries.reduce(
		(sum, entry) => ({ additions: sum.additions + entry.additions, deletions: sum.deletions + entry.deletions }),
		{ additions: 0, deletions: 0 },
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-sm">
				{diff.data && (
					<div className="flex min-w-0 items-center gap-2 text-muted-foreground">
						<span className="truncate">
							against <span className="font-medium text-foreground">{diff.data.base.label}</span>{" "}
							<span className="font-mono text-xs">{diff.data.base.commit.slice(0, 7)}</span>
						</span>
						<span>
							{entries.length} {entries.length === 1 ? "file" : "files"}
						</span>
						<span className="font-mono text-xs">
							<span className="text-success">+{totals.additions}</span>{" "}
							<span className="text-destructive">−{totals.deletions}</span>
						</span>
					</div>
				)}
				<div className="ml-auto flex items-center gap-1.5">
					<ToggleGroup
						size="sm"
						variant="outline"
						spacing={0}
						className="*:aria-pressed:bg-secondary *:aria-pressed:text-foreground"
						value={[layout]}
						onValueChange={(value: string[]) => {
							const next = value[0];
							if (next === "split" || next === "unified") setLayout(next);
						}}
					>
						<ToggleGroupItem value="split" aria-label="Side by side">
							Split
						</ToggleGroupItem>
						<ToggleGroupItem value="unified" aria-label="One column">
							Unified
						</ToggleGroupItem>
					</ToggleGroup>
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Refresh"
									disabled={diff.loading}
									onClick={() => void diff.reload()}
								/>
							}
						>
							{diff.loading ? <Spinner /> : <RefreshCwIcon />}
						</TooltipTrigger>
						<TooltipContent>Load the changes again</TooltipContent>
					</Tooltip>
					<CommentList comments={comments} outdated={outdated} jump={jump} remove={remove} />
					<Button size="sm" disabled={comments.length === 0 || sending} onClick={() => void send()}>
						{sending ? <Spinner /> : <SendIcon />}
						Send to agent
					</Button>
				</div>
			</div>
			<div className="relative min-h-0 flex-1">
				{diff.data === undefined ? (
					<Empty className="h-full">
						{diff.error ? (
							<EmptyHeader>
								<EmptyTitle>The changes could not be loaded</EmptyTitle>
								<EmptyDescription>{diff.error}</EmptyDescription>
							</EmptyHeader>
						) : (
							<Spinner />
						)}
					</Empty>
				) : entries.length === 0 ? (
					<Empty className="h-full">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<FileDiffIcon />
							</EmptyMedia>
							<EmptyTitle>No changes</EmptyTitle>
							<EmptyDescription>
								{diff.data.base.label === "HEAD"
									? "Nothing differs from the last commit."
									: `Nothing differs from where this worktree branched off ${diff.data.base.label}.`}
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<CodeView<Note>
						ref={viewer}
						items={items}
						options={options}
						className="absolute inset-0"
						style={{ overflow: "auto" }}
						renderAnnotation={renderAnnotation}
						renderHeaderPrefix={(item) => (
							<button
								type="button"
								aria-label={item.collapsed ? "Expand" : "Collapse"}
								className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
								onClick={() => setToggled((set) => toggle(set, item.id))}
							>
								<ChevronRightIcon className={cn("size-4 transition-transform", !item.collapsed && "rotate-90")} />
							</button>
						)}
						renderHeaderMetadata={(item) => <FileBadges entry={byPath.get(item.id)} />}
					/>
				)}
			</div>
		</div>
	);
}

/** What the header says about a file beyond its name and counts. */
function FileBadges({ entry }: { entry: Entry | undefined }) {
	if (!entry) return null;
	return (
		<span className="flex items-center gap-1 font-sans">
			{entry.file.binary && <Badge variant="outline">binary</Badge>}
			{entry.file.omitted !== undefined && <Badge variant="destructive">too large to show</Badge>}
		</span>
	);
}

function CommentEditor({ draft, save, cancel }: { draft: Editing; save(draft: Editing): void; cancel(): void }) {
	const [kind, setKind] = useState<CommentKind>(draft.kind);
	const [text, setText] = useState(draft.text);
	const submit = () => save({ ...draft, kind, text });
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			submit();
		} else if (event.key === "Escape") {
			event.preventDefault();
			cancel();
		}
	};
	return (
		<div className="mx-3 my-2 flex max-w-2xl flex-col gap-2 rounded-lg border bg-card p-2 font-sans text-sm">
			<div className="flex items-center gap-2">
				<ToggleGroup
					size="sm"
					variant="outline"
					spacing={0}
					className="*:aria-pressed:bg-secondary *:aria-pressed:text-foreground"
					value={[kind]}
					onValueChange={(value: string[]) => {
						const next = value[0];
						if (next === "change" || next === "question") setKind(next);
					}}
				>
					<ToggleGroupItem value="change">Change request</ToggleGroupItem>
					<ToggleGroupItem value="question">Question</ToggleGroupItem>
				</ToggleGroup>
				<span className="text-xs text-muted-foreground">{where(draft)}</span>
			</div>
			<Textarea
				autoFocus
				value={text}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={kind === "question" ? "What do you want to know?" : "What should change?"}
				className="min-h-16"
			/>
			<div className="flex justify-end gap-1.5">
				<Button variant="ghost" size="sm" onClick={cancel}>
					Cancel
				</Button>
				<Button size="sm" disabled={text.trim() === ""} onClick={submit}>
					{draft.id === undefined ? "Add comment" : "Save"}
				</Button>
			</div>
		</div>
	);
}

function CommentCard({ comment, edit, remove }: { comment: ReviewComment; edit(): void; remove(): void }) {
	return (
		<div className="group mx-3 my-2 flex max-w-2xl flex-col gap-1 rounded-lg border bg-card px-3 py-2 font-sans text-sm">
			<div className="flex items-center gap-2">
				<KindBadge kind={comment.kind} />
				<span className="text-xs text-muted-foreground">{where(comment)}</span>
				<div className="ml-auto flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
					<Button variant="ghost" size="icon-xs" aria-label="Edit comment" onClick={edit}>
						<PencilIcon />
					</Button>
					<Button variant="ghost" size="icon-xs" aria-label="Delete comment" onClick={remove}>
						<TrashIcon />
					</Button>
				</div>
			</div>
			<p className="whitespace-pre-wrap">{comment.text}</p>
		</div>
	);
}

function KindBadge({ kind }: { kind: CommentKind }) {
	return <Badge variant={kind === "question" ? "secondary" : "outline"}>{kind === "question" ? "Question" : "Change"}</Badge>;
}

function CommentList({
	comments,
	outdated,
	jump,
	remove,
}: {
	comments: readonly ReviewComment[];
	outdated: ReadonlySet<string>;
	jump(comment: ReviewComment): void;
	remove(id: string): void;
}) {
	return (
		<Popover>
			<PopoverTrigger render={<Button variant="ghost" size="sm" disabled={comments.length === 0} />}>
				<MessageSquareIcon />
				{comments.length}
			</PopoverTrigger>
			<PopoverContent align="end" className="w-96 gap-1 p-1.5">
				{comments.map((comment) => (
					<div key={comment.id} className="group flex items-start gap-1 rounded-md hover:bg-accent">
						<button
							type="button"
							className="flex min-w-0 flex-1 flex-col gap-1 px-2 py-1.5 text-left text-sm"
							onClick={() => jump(comment)}
						>
							<span className="flex items-center gap-1.5">
								<KindBadge kind={comment.kind} />
								<span className="truncate font-mono text-xs text-muted-foreground">
									{comment.path}:{comment.start}
								</span>
								{outdated.has(comment.id) && <Badge variant="destructive">outdated</Badge>}
							</span>
							<span className="line-clamp-2">{comment.text}</span>
						</button>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Delete comment"
							className="mt-1.5 mr-1 opacity-0 group-hover:opacity-100"
							onClick={() => remove(comment.id)}
						>
							<TrashIcon />
						</Button>
					</div>
				))}
			</PopoverContent>
		</Popover>
	);
}

function where(comment: Pick<ReviewComment, "side" | "start" | "end">): string {
	const lines = comment.start === comment.end ? `Line ${comment.start}` : `Lines ${comment.start}–${comment.end}`;
	return comment.side === "deletions" ? `${lines}, removed` : lines;
}

/** The workspace's diff: loaded when it becomes visible, then kept until reloaded. */
function useWorkspaceDiff(workspace: string, visible: boolean) {
	const [state, setState] = useState<{ data?: WorkspaceDiff; error?: string; loading: boolean }>({ loading: false });
	const request = useRef(0);
	const shown = useRef(false);
	const reload = useCallback(async () => {
		const id = ++request.current;
		setState((previous) => ({ ...previous, loading: true }));
		try {
			const data = await api.diff(workspace);
			if (id !== request.current) return;
			shown.current = true;
			setState({ data, loading: false });
		} catch (error) {
			if (id !== request.current) return;
			const text = error instanceof Error ? error.message : String(error);
			setState((previous) => ({ ...previous, error: text, loading: false }));
			// With a diff on screen, it stays: the failure is a toast rather than the whole tab.
			if (shown.current) toast.error(text);
		}
	}, [workspace]);
	useEffect(() => {
		if (visible) void reload();
	}, [visible, reload]);
	return { ...state, reload };
}

/** The files as the viewer shows them; a file whose diff did not change keeps its entry (and what the viewer loaded). */
function useEntries(data: WorkspaceDiff | undefined): readonly Entry[] {
	const cache = useRef(new Map<string, Entry>());
	return useMemo(() => {
		if (!data) return [];
		const next = new Map<string, Entry>();
		const entries = data.files.map((file) => {
			const entry = entryOf(file, cache.current.get(file.path));
			next.set(file.path, entry);
			return entry;
		});
		cache.current = next;
		return entries;
	}, [data]);
}

function entryOf(file: DiffFile, previous: Entry | undefined): Entry {
	const signature = hash(file.patch);
	if (previous?.signature === signature) return { ...previous, file };
	const { additions, deletions } = patchStats(file.patch);
	const fileDiff = processFile(file.patch, { cacheKey: `${file.path}:${signature}`, isGitDiff: true });
	if (fileDiff === undefined) throw new Error(`Unreadable diff of ${file.path}`);
	return { file, fileDiff, signature, additions, deletions };
}

/** The viewer's items: one per file, a new version whenever what it shows changes. */
function useItems(
	entries: readonly Entry[],
	comments: readonly ReviewComment[],
	outdated: ReadonlySet<string>,
	editing: Editing | undefined,
	toggled: ReadonlySet<string>,
): CodeViewItem<Note>[] {
	const previous = useRef(new Map<string, { item: CodeViewItem<Note>; annotations: string }>());
	return useMemo(() => {
		const next = new Map<string, { item: CodeViewItem<Note>; annotations: string }>();
		const items = entries.map((entry) => {
			const id = entry.file.path;
			const annotations: DiffLineAnnotation<Note>[] = comments
				.filter((comment) => comment.path === id && !outdated.has(comment.id))
				.map((comment) => ({ side: comment.side, lineNumber: comment.end, metadata: { id: comment.id } }));
			if (editing?.path === id && editing.id === undefined)
				annotations.push({ side: editing.side, lineNumber: editing.end, metadata: { id: NEW } });
			// The edited comment re-renders as an editor: its annotation must change for the viewer to notice.
			const key = `${JSON.stringify(annotations)}:${editing?.path === id ? (editing.id ?? NEW) : ""}`;
			const collapsed = startsCollapsed(entry) !== toggled.has(id);
			const before = previous.current.get(id);
			const same =
				before?.item.type === "diff" &&
				before.item.fileDiff === entry.fileDiff &&
				before.annotations === key &&
				before.item.collapsed === collapsed;
			const item: CodeViewItem<Note> =
				same && before
					? before.item
					: {
							id,
							type: "diff",
							fileDiff: entry.fileDiff,
							annotations,
							collapsed,
							version: (before?.item.version ?? 0) + 1,
						};
			next.set(id, { item, annotations: key });
			return item;
		});
		previous.current = next;
		return items;
	}, [entries, comments, outdated, editing, toggled]);
}

function startsCollapsed(entry: Entry): boolean {
	return LOCK_FILE.test(entry.file.path) || entry.additions + entry.deletions > LARGE_DIFF_LINES;
}

function toggle(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
	const next = new Set(set);
	if (!next.delete(id)) next.add(id);
	return next;
}

/** Added and removed lines in a git patch. */
function patchStats(patch: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	let inHunk = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("@@ ")) inHunk = true;
		else if (!inHunk) continue;
		else if (line.startsWith("+")) additions++;
		else if (line.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}

/** FNV-1a, enough to tell one version of a file's diff from another. */
function hash(text: string): string {
	let value = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		value ^= text.charCodeAt(index);
		value = Math.imul(value, 0x01000193);
	}
	return (value >>> 0).toString(36);
}

function useComments(workspace: string): [readonly ReviewComment[], (next: readonly ReviewComment[]) => void] {
	const [comments, setState] = useState<readonly ReviewComment[]>(() => loadComments(workspace));
	const set = useCallback(
		(next: readonly ReviewComment[]) => {
			setState(next);
			saveComments(workspace, next);
		},
		[workspace],
	);
	return [comments, set];
}

function usePreference<T extends string>(key: string, initial: T, allowed: readonly T[]): [T, (value: T) => void] {
	const [value, setValue] = useState<T>(() => {
		try {
			const stored = localStorage.getItem(key);
			return allowed.includes(stored as T) ? (stored as T) : initial;
		} catch {
			return initial;
		}
	});
	const set = useCallback(
		(next: T) => {
			setValue(next);
			try {
				localStorage.setItem(key, next);
			} catch {
				// A convenience only.
			}
		},
		[key],
	);
	return [value, set];
}
