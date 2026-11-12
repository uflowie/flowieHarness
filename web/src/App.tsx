// The app shell: the project sidebar and the selected workspace, chosen by the URL hash (`#/w/<id>`).
import type { ProjectListing } from "@flowie/daemon/protocol";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Workspace } from "@/components/workspace";
import { api } from "@/lib/api";
import { daemon } from "@/lib/socket";

export function App() {
	const [projects, setProjects] = useState<ProjectListing[]>();
	const [error, setError] = useState<string>();
	const selected = useHashWorkspace();
	const statuses = useSyncExternalStore(daemon.subscribe, () => daemon.statuses);
	const connected = useSyncExternalStore(daemon.subscribe, () => daemon.connected);

	const refresh = useCallback(async () => {
		try {
			setProjects(await api.projects());
			setError(undefined);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	}, []);

	useEffect(() => {
		void refresh();
		// Worktrees made or removed outside flowie show up when the window comes back.
		const onFocus = () => void refresh();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);

	// After a reconnect (a daemon restart) the projects may have changed.
	useEffect(() => {
		if (connected) void refresh();
	}, [connected, refresh]);

	const found = projects
		?.flatMap((project) => project.workspaces.map((workspace) => ({ project, workspace })))
		.find((each) => each.workspace.id === selected);

	return (
		<SidebarProvider>
			<AppSidebar
				projects={projects}
				statuses={statuses}
				connected={connected}
				selected={selected}
				select={(id) => {
					location.hash = `#/w/${id}`;
				}}
				refresh={refresh}
			/>
			<SidebarInset className="h-svh min-h-0 overflow-hidden">
				{found ? (
					<Workspace
						key={found.workspace.id}
						workspace={found.workspace}
						projectName={found.project.name}
						status={statuses[found.workspace.id] ?? found.workspace.status}
					/>
				) : (
					<Empty className="h-full">
						<EmptyHeader>
							<EmptyTitle>{error ? "The daemon is unreachable" : "Select a worktree"}</EmptyTitle>
							<EmptyDescription>{error ?? "Each worktree in the sidebar has its own agent."}</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)}
			</SidebarInset>
		</SidebarProvider>
	);
}

function useHashWorkspace(): string | undefined {
	const read = () => /^#\/w\/([^/]+)/.exec(location.hash)?.[1];
	const [id, setId] = useState(read);
	useEffect(() => {
		const onChange = () => setId(read());
		window.addEventListener("hashchange", onChange);
		return () => window.removeEventListener("hashchange", onChange);
	}, []);
	return id;
}
