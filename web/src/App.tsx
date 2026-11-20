// The app shell: the project sidebar and the selected workspace, chosen by the URL hash (`#/w/<id>`). Recently shown
// workspaces stay mounted and live, hidden with `visibility: hidden`, so switching back to one is instant and keeps its
// scroll position and drafts.
//
// Not `<Activity mode="hidden">`: hiding detaches refs and showing reattaches them children first, so the message
// scroller measures its transcript before it has its viewport, takes that for "at the bottom" and jumps to the end.
// `display: none` would make it measure a zero-size viewport, with the same result. Hidden by visibility, a workspace
// keeps its layout and nothing re-measures.
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

	const kept = useKeptWorkspaces(selected);
	const listed = new Map(
		projects?.flatMap((project) => project.workspaces.map((workspace) => [workspace.id, { project, workspace }])),
	);
	const found = selected === undefined ? undefined : listed.get(selected);

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
			{/* Every kept workspace in the same grid cell; only the selected one is visible. */}
			<SidebarInset className="grid h-svh min-h-0 overflow-hidden *:col-start-1 *:row-start-1 *:min-h-0 *:min-w-0">
				{kept.map((id) => {
					const each = listed.get(id);
					const active = id === selected;
					return (
						each && (
							// Transitions off while hidden: an inherited `visibility` change transitions too, so anything with
							// `transition-all` (buttons) would stay visible over the next workspace for its duration.
							<div key={id} className={active ? undefined : "invisible **:transition-none"} inert={!active}>
								<Workspace
									workspace={each.workspace}
									projectName={each.project.name}
									status={statuses[id] ?? each.workspace.status}
									active={active}
								/>
							</div>
						)
					);
				})}
				{!found && (
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

/** How many workspaces stay mounted (hidden) after being shown. Each keeps its watch, so the daemon keeps it open. */
const KEEP_MOUNTED = 5;

type Kept = { readonly selected: string | undefined; readonly ids: readonly string[]; readonly recent: readonly string[] };

/**
 * The workspaces to keep mounted: the selected one and the most recently selected others, up to KEEP_MOUNTED, in the
 * order they were first shown. The order never changes, since moving a mounted workspace in the DOM loses its scroll
 * position. Updated during render, so a newly selected workspace mounts in the same render that selects it.
 */
function useKeptWorkspaces(selected: string | undefined): readonly string[] {
	const [kept, setKept] = useState<Kept>({ selected: undefined, ids: [], recent: [] });
	if (kept.selected === selected) return kept.ids;
	const recent =
		selected === undefined ? kept.recent : [selected, ...kept.recent.filter((id) => id !== selected)].slice(0, KEEP_MOUNTED);
	const ids = kept.ids.filter((id) => recent.includes(id));
	if (selected !== undefined && !ids.includes(selected)) ids.push(selected);
	setKept({ selected, ids, recent });
	return ids;
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
