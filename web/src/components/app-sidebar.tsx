// The project sidebar: each registered repository with its worktrees and their agents' status.
import type { ProjectListing, WorkspaceListing, WorkspaceStatus } from "@flowie/daemon/protocol";
import { EllipsisIcon, FolderPlusIcon, GitBranchPlusIcon, PlusIcon, TrashIcon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { RepoDialog } from "@/components/repo-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupAction,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";

type Props = {
	readonly projects: readonly ProjectListing[] | undefined;
	readonly statuses: Readonly<Record<string, WorkspaceStatus>>;
	readonly connected: boolean;
	readonly selected: string | undefined;
	select(workspace: string): void;
	/** Lists the projects again after a change. */
	refresh(): Promise<void>;
};

export function AppSidebar({ projects, statuses, connected, selected, select, refresh }: Props) {
	const [adding, setAdding] = useState(false);

	return (
		<Sidebar>
			<SidebarHeader>
				<div className="flex items-center gap-2 px-2 pt-1">
					<span className="font-semibold tracking-tight">flowie</span>
					<Tooltip>
						<TooltipTrigger
							render={<span className={cn("size-2 rounded-full", connected ? "bg-success" : "bg-destructive")} />}
						/>
						<TooltipContent>{connected ? "Connected to the daemon" : "Reconnecting to the daemon…"}</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger
							render={
								<Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Add a repository" onClick={() => setAdding(true)} />
							}
						>
							<PlusIcon />
						</TooltipTrigger>
						<TooltipContent>Add a repository</TooltipContent>
					</Tooltip>
				</div>
			</SidebarHeader>
			<SidebarContent>
				{projects?.length === 0 && (
					<Empty>
						<EmptyHeader>
							<EmptyTitle>No repositories yet</EmptyTitle>
							<EmptyDescription>Each worktree of a repository gets its own agent.</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button size="sm" onClick={() => setAdding(true)}>
								<FolderPlusIcon />
								Add a repository
							</Button>
						</EmptyContent>
					</Empty>
				)}
				{projects?.map((project) => (
					<Project
						key={project.id}
						project={project}
						statuses={statuses}
						selected={selected}
						select={select}
						refresh={refresh}
					/>
				))}
			</SidebarContent>
			<RepoDialog
				open={adding}
				onOpenChange={setAdding}
				add={async (path) => {
					const project = await api.addProject(path);
					await refresh();
					setAdding(false);
					const main = project.workspaces[0];
					if (main) select(main.id);
				}}
			/>
		</Sidebar>
	);
}

function Project({
	project,
	statuses,
	selected,
	select,
	refresh,
}: {
	project: ProjectListing;
	statuses: Readonly<Record<string, WorkspaceStatus>>;
	selected: string | undefined;
	select(workspace: string): void;
	refresh(): Promise<void>;
}) {
	const [creating, setCreating] = useState(false);
	const confirm = useConfirm();

	const removeProject = async () => {
		const confirmed = await confirm({
			title: `Remove ${project.name} from flowie?`,
			description: "Nothing on disk changes: the repository, its worktrees and the agents' history stay.",
			action: "Remove",
			destructive: true,
		});
		if (!confirmed) return;
		await api.removeProject(project.id).catch(fail);
		await refresh();
	};

	const removeWorktree = async (workspace: WorkspaceListing, name: string) => {
		const confirmed = await confirm({
			title: `Remove worktree ${name}?`,
			description: "Its folder is deleted. The agent's history is archived.",
			action: "Remove",
			destructive: true,
		});
		if (!confirmed) return;
		try {
			await api.removeWorktree(workspace.id, false);
		} catch (error) {
			if (!(error instanceof ApiError && error.status === 400)) return fail(error);
			const force = await confirm({
				title: "Git refused to remove it",
				description: `${error.message}\n\nRemove it anyway and discard its changes?`,
				action: "Discard and remove",
				destructive: true,
			});
			if (!force) return;
			const removed = await api.removeWorktree(workspace.id, true).then(
				() => true,
				(caught: unknown) => (fail(caught), false),
			);
			if (!removed) return;
		}
		if (selected === workspace.id) {
			const main = project.workspaces.find((each) => each.main);
			if (main) select(main.id);
		}
		await refresh();
	};

	return (
		<SidebarGroup>
			<SidebarGroupLabel title={project.path}>{project.name}</SidebarGroupLabel>
			<DropdownMenu>
				<DropdownMenuTrigger render={<SidebarGroupAction aria-label={`${project.name} actions`} />}>
					<EllipsisIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" side="right" className="w-48">
					<DropdownMenuItem onClick={() => setCreating(true)}>
						<GitBranchPlusIcon />
						New worktree
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onClick={() => void removeProject()}>
						<TrashIcon />
						Remove from flowie
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<SidebarGroupContent>
				{project.error && <p className="px-2 text-xs text-destructive">{project.error}</p>}
				<SidebarMenu>
					{project.workspaces.map((workspace) => {
						const status = statuses[workspace.id] ?? workspace.status;
						const name = workspace.branch ?? workspace.head?.slice(0, 8) ?? "detached";
						return (
							<SidebarMenuItem key={workspace.id}>
								<SidebarMenuButton isActive={workspace.id === selected} onClick={() => select(workspace.id)}>
									<StatusDot status={status} />
									<span className="truncate">{name}</span>
									{workspace.prunable && (
										<Badge variant="destructive" className="ml-auto">
											missing
										</Badge>
									)}
								</SidebarMenuButton>
								{!workspace.main && (
									<SidebarMenuAction showOnHover aria-label={`Remove ${name}`} onClick={() => void removeWorktree(workspace, name)}>
										<XIcon />
									</SidebarMenuAction>
								)}
							</SidebarMenuItem>
						);
					})}
				</SidebarMenu>
			</SidebarGroupContent>
			<NewWorktreeDialog
				project={project}
				open={creating}
				onOpenChange={setCreating}
				created={async (workspace) => {
					await refresh();
					setCreating(false);
					select(workspace.id);
				}}
			/>
		</SidebarGroup>
	);
}

function NewWorktreeDialog({
	project,
	open,
	onOpenChange,
	created,
}: {
	project: ProjectListing;
	open: boolean;
	onOpenChange(open: boolean): void;
	created(workspace: WorkspaceListing): Promise<void>;
}) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const formId = `new-worktree-${project.id}`;
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		try {
			await created(await api.createWorktree(project.id, name.trim() || undefined));
			setName("");
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>New worktree</DialogTitle>
					<DialogDescription>
						A new branch of {project.name}, from what its main checkout has checked out, with its own agent.
					</DialogDescription>
				</DialogHeader>
				<form id={formId} onSubmit={(event) => void submit(event)}>
					<Input
						autoFocus
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="Branch name, or leave empty for a random one"
						aria-label="Branch name"
						className="font-mono"
					/>
				</form>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
					<Button type="submit" form={formId} disabled={busy}>
						Create
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function StatusDot({ status }: { status: WorkspaceStatus }) {
	const tone =
		status.kind === "busy" || status.kind === "opening"
			? "animate-pulse bg-warning"
			: status.kind === "failed" || (status.kind === "idle" && status.runFailure)
				? "bg-destructive"
				: status.kind === "idle"
					? "bg-success"
					: "border border-muted-foreground";
	return <span className={cn("size-2 shrink-0 rounded-full", tone)} />;
}

function fail(error: unknown): void {
	toast.error(error instanceof Error ? error.message : String(error));
}
