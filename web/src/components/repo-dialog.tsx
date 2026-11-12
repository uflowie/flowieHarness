// "Add a repository": a folder browser over the daemon's file system (which may not be this browser's, e.g. WSL), so
// no browser file picker. Folders open on select; git repositories get an Add button.
import type { DirectoryListing } from "@flowie/daemon/protocol";
import { ArrowUpIcon, FolderGitIcon, FolderIcon, HardDriveIcon, HouseIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type Props = {
	readonly open: boolean;
	onOpenChange(open: boolean): void;
	/** Adds the repository at `path`; a rejection is shown in the dialog. */
	add(path: string): Promise<void>;
};

const LAST_KEY = "flowie.browse.last";

export function RepoDialog({ open, onOpenChange, add }: Props) {
	const [listing, setListing] = useState<DirectoryListing>();
	const [search, setSearch] = useState("");
	const [error, setError] = useState<string>();
	const [adding, setAdding] = useState(false);

	const browse = (path: string | undefined) =>
		api.directories(path).then(
			(next) => {
				setListing(next);
				setSearch("");
				setError(undefined);
				remember(next.path);
			},
			(caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
		);

	useEffect(() => {
		if (open) void browse(recall());
	}, [open]);

	const submit = async (path: string) => {
		if (adding) return;
		setAdding(true);
		setError(undefined);
		try {
			await add(path);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setAdding(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-[min(600px,90svh)] flex-col gap-0 p-0 sm:max-w-3xl">
				<DialogHeader className="border-b p-4">
					<DialogTitle>Add a repository</DialogTitle>
					<DialogDescription>Browse the daemon's machine to a git repository.</DialogDescription>
				</DialogHeader>
				<div className="grid min-h-0 flex-1 grid-cols-[180px_1fr]">
					<nav className="flex flex-col gap-0.5 overflow-y-auto border-r p-2">
						{listing && (
							<>
								<Place icon={<HouseIcon />} label="Home" path={listing.home} current={listing.path} browse={browse} />
								{listing.places.length > 0 && <Heading>Project folders</Heading>}
								{listing.places.map((place) => (
									<Place key={place} icon={<FolderIcon />} label={shortName(place)} path={place} current={listing.path} browse={browse} />
								))}
								<Heading>Drives</Heading>
								{listing.roots.map((root) => (
									<Place key={root} icon={<HardDriveIcon />} label={root} path={root} current={listing.path} browse={browse} />
								))}
							</>
						)}
					</nav>
					<div className="flex min-h-0 min-w-0 flex-col">
						<div className="flex items-center gap-1 border-b px-2 py-1.5">
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Up"
								disabled={!listing?.parent}
								onClick={() => listing?.parent && void browse(listing.parent)}
							>
								<ArrowUpIcon />
							</Button>
							{listing && <Crumbs path={listing.path} browse={browse} />}
						</div>
						<Command
							className="min-h-0 flex-1 rounded-none bg-transparent"
							onKeyDown={(event) => {
								if (event.key === "Backspace" && search === "" && listing?.parent) {
									event.preventDefault();
									void browse(listing.parent);
								}
							}}
						>
							<CommandInput value={search} onValueChange={setSearch} placeholder="Filter folders" autoFocus />
							<CommandList className="max-h-none min-h-0 flex-1">
								<CommandEmpty>{listing?.error ? `Cannot open this folder (${listing.error})` : "No folders here."}</CommandEmpty>
								{listing?.entries.map((entry) => (
									<CommandItem key={entry.path} value={entry.name} onSelect={() => void browse(entry.path)} className="group">
										{entry.repo ? <FolderGitIcon className="text-success" /> : <FolderIcon />}
										<span className="truncate">{entry.name}</span>
										{entry.repo && <Badge variant="outline" className="text-success">git</Badge>}
										{entry.repo && (
											<CommandShortcut className="tracking-normal">
												<Button
													size="xs"
													disabled={adding}
													onClick={(event) => {
														event.stopPropagation();
														void submit(entry.path);
													}}
												>
													Add
												</Button>
											</CommandShortcut>
										)}
									</CommandItem>
								))}
							</CommandList>
						</Command>
					</div>
				</div>
				<DialogFooter className="mx-0 mb-0 items-center p-3 sm:justify-between">
					<p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
						{error ??
							(listing?.repo ? "This folder is a git repository." : "Enter opens a folder, Backspace goes up.")}
					</p>
					<div className="flex gap-2">
						<Button variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button disabled={!listing?.repo || adding} onClick={() => listing && void submit(listing.path)}>
							Add this folder
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function Heading({ children }: { children: string }) {
	return <div className="mt-3 px-2 pb-1 text-xs font-medium text-muted-foreground">{children}</div>;
}

function Place({
	icon,
	label,
	path,
	current,
	browse,
}: {
	icon: React.ReactNode;
	label: string;
	path: string;
	current: string;
	browse(path: string): void;
}) {
	return (
		<Button
			variant={path === current ? "secondary" : "ghost"}
			size="sm"
			className="justify-start"
			title={path}
			onClick={() => browse(path)}
		>
			{icon}
			<span className="truncate">{label}</span>
		</Button>
	);
}

function Crumbs({ path, browse }: { path: string; browse(path: string): void }) {
	const crumbs = splitPath(path);
	return (
		<Breadcrumb className="min-w-0 overflow-x-auto">
			<BreadcrumbList className="flex-nowrap font-mono text-xs">
				{crumbs.map((crumb, index) => (
					<Fragment key={crumb.path}>
						{index > 0 && <BreadcrumbSeparator />}
						<BreadcrumbItem>
							{index === crumbs.length - 1 ? (
								<BreadcrumbPage>{crumb.label}</BreadcrumbPage>
							) : (
								<BreadcrumbLink render={<button type="button" onClick={() => browse(crumb.path)} />}>
									{crumb.label}
								</BreadcrumbLink>
							)}
						</BreadcrumbItem>
					</Fragment>
				))}
			</BreadcrumbList>
		</Breadcrumb>
	);
}

/** The folders from the root down to `path`: `C:\Users\me` gives `C:\`, `Users`, `me`. */
function splitPath(path: string): { label: string; path: string }[] {
	const sep = path.includes("\\") ? "\\" : "/";
	const parts = path.split(sep).filter(Boolean);
	const root = sep === "\\" ? `${parts.shift()}\\` : "/";
	const result = [{ label: root, path: root }];
	let current = root;
	for (const part of parts) {
		current = current.endsWith(sep) ? current + part : current + sep + part;
		result.push({ label: part, path: current });
	}
	return result;
}

/** The last two folders of `path`, enough to tell project folders apart. */
function shortName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || path;
}

function remember(path: string): void {
	try {
		localStorage.setItem(LAST_KEY, path);
	} catch {
		// A convenience only.
	}
}

function recall(): string | undefined {
	try {
		return localStorage.getItem(LAST_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}
