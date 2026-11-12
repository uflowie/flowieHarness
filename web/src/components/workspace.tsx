// One workspace (worktree): a header with where it is and what its agent is doing, and tabs for its views.
import type { UsageState } from "@earendil-works/pi-durable";
import type { WorkspaceListing, WorkspaceStatus } from "@flowie/daemon/protocol";
import { EllipsisVerticalIcon, ListRestartIcon, ShrinkIcon } from "lucide-react";
import { toast } from "sonner";
import { Chat } from "@/components/chat";
import { useConfirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConversation } from "@/hooks/use-conversation";
import { api } from "@/lib/api";

type Props = { readonly workspace: WorkspaceListing; readonly projectName: string; readonly status: WorkspaceStatus };

export function Workspace({ workspace, projectName, status }: Props) {
	const conversation = useConversation(workspace.id);
	const confirm = useConfirm();
	const fail = (error: unknown) => toast.error(error instanceof Error ? error.message : String(error));

	return (
		<div className="flex h-svh min-h-0 flex-col">
			<header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
				<SidebarTrigger />
				<Separator orientation="vertical" className="mr-1 h-4! self-center" />
				<Breadcrumb>
					<BreadcrumbList>
						<BreadcrumbItem>{projectName}</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<Tooltip>
								<TooltipTrigger render={<BreadcrumbPage />}>
									{workspace.branch ?? workspace.head?.slice(0, 8) ?? "detached"}
								</TooltipTrigger>
								<TooltipContent>{workspace.path}</TooltipContent>
							</Tooltip>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
				<StatusBadge status={status} />
				<div className="ml-auto flex items-center gap-2">
					<Usage usage={conversation.view?.docs["pi.usage"] as UsageState | undefined} />
					<DropdownMenu>
						<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Agent actions" />}>
							<EllipsisVerticalIcon />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-52">
							<DropdownMenuItem onClick={() => api.compact(workspace.id).catch(fail)}>
								<ShrinkIcon />
								Compact context
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={async () => {
									const confirmed = await confirm({
										title: "Start a fresh context?",
										description: "The agent stops seeing the conversation so far. The history stays visible here.",
										action: "Start fresh",
									});
									if (confirmed) await api.reset(workspace.id).catch(fail);
								}}
							>
								<ListRestartIcon />
								New context
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</header>
			<Tabs defaultValue="chat" className="flex min-h-0 flex-1 flex-col gap-0">
				<div className="border-b px-3">
					<TabsList variant="line">
						<TabsTrigger value="chat">Chat</TabsTrigger>
					</TabsList>
				</div>
				<TabsContent value="chat" className="flex min-h-0 flex-1 flex-col">
					<Chat workspace={workspace.id} conversation={conversation} />
				</TabsContent>
			</Tabs>
		</div>
	);
}

function StatusBadge({ status }: { status: WorkspaceStatus }) {
	switch (status.kind) {
		case "busy":
		case "opening":
			return (
				<Badge variant="secondary">
					<Spinner className="size-3" />
					{status.kind === "busy" ? "working" : "opening"}
				</Badge>
			);
		case "failed":
			return (
				<Tooltip>
					<TooltipTrigger render={<Badge variant="destructive" />}>failed</TooltipTrigger>
					<TooltipContent>{status.error}</TooltipContent>
				</Tooltip>
			);
		case "idle":
			return <Badge variant="outline">idle</Badge>;
		case "closed":
			return null;
	}
}

function Usage({ usage }: { usage: UsageState | undefined }) {
	if (!usage) return null;
	const models = Object.values(usage.models);
	const tokens = models.reduce((sum, each) => sum + (each.totalTokens ?? 0), 0);
	if (tokens === 0) return null;
	const cost = models.reduce((sum, each) => sum + (each.cost?.total ?? 0), 0);
	return (
		<Tooltip>
			<TooltipTrigger render={<Badge variant="outline" className="font-mono" />}>${cost.toFixed(2)}</TooltipTrigger>
			<TooltipContent>{tokens.toLocaleString()} tokens</TooltipContent>
		</Tooltip>
	);
}
