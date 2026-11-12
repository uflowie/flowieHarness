// Projects (git repositories the user registered) and their worktrees, which are flowie's workspaces. Projects persist
// in `projects.json`; worktrees are always read from git, so ones made or removed outside flowie show up too.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DataDir } from "./data-dir.ts";
import {
	addWorktree,
	branchExists,
	isBranchName,
	listWorktrees,
	mainWorktree,
	removeWorktree,
	type Worktree,
} from "./git.ts";
import { randomName } from "./random-name.ts";

export type Project = {
	readonly id: string;
	readonly name: string;
	/** The main worktree's directory. */
	readonly path: string;
};

/** A worktree of a project: one workspace, with one agent. */
export type Workspace = Worktree & {
	readonly id: string;
	readonly projectId: string;
};

/** A stable ID for a directory: the same directory gives the same ID across restarts and path spellings. */
function pathId(path: string): string {
	let canonical = path;
	try {
		canonical = realpathSync.native(path);
	} catch {
		// Gone (a prunable worktree): its recorded path still names it.
	}
	if (process.platform === "win32") canonical = canonical.toLowerCase();
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export class Projects {
	readonly #dir: DataDir;
	#projects: Project[];
	/** Every project's workspaces from the last listing, by workspace ID. */
	readonly #workspaces = new Map<string, Workspace>();
	/** Serializes git changes per project, so two worktree adds never race on one repository. */
	readonly #queues = new Map<string, Promise<unknown>>();

	constructor(dir: DataDir) {
		this.#dir = dir;
		this.#projects = load(dir.projectsFile);
	}

	list(): readonly Project[] {
		return this.#projects;
	}

	get(id: string): Project | undefined {
		return this.#projects.find((project) => project.id === id);
	}

	/** Registers the repository containing `path` (by its main worktree); an already registered one is returned as is. */
	async add(path: string): Promise<Project> {
		const main = await mainWorktree(path);
		const id = pathId(main);
		const existing = this.get(id);
		if (existing) return existing;
		const project = { id, name: basename(main), path: main };
		this.#projects = [...this.#projects, project];
		this.#save();
		await this.workspaces(project);
		return project;
	}

	/** Unregisters a project; its worktrees and their data stay on disk. */
	remove(id: string): boolean {
		const before = this.#projects.length;
		this.#projects = this.#projects.filter((project) => project.id !== id);
		if (this.#projects.length === before) return false;
		for (const [key, workspace] of this.#workspaces) if (workspace.projectId === id) this.#workspaces.delete(key);
		this.#save();
		return true;
	}

	/** A project's workspaces as git lists them now. */
	async workspaces(project: Project): Promise<Workspace[]> {
		const listed = (await listWorktrees(project.path)).map((worktree) => ({
			...worktree,
			id: pathId(worktree.path),
			projectId: project.id,
		}));
		for (const [key, workspace] of this.#workspaces)
			if (workspace.projectId === project.id) this.#workspaces.delete(key);
		for (const workspace of listed) this.#workspaces.set(workspace.id, workspace);
		return listed;
	}

	/** The workspace with `id`; lists every project again before giving up, for worktrees added outside flowie. */
	async workspace(id: string): Promise<Workspace | undefined> {
		const known = this.#workspaces.get(id);
		if (known) return known;
		for (const project of this.#projects) await this.workspaces(project).catch(() => []);
		return this.#workspaces.get(id);
	}

	/**
	 * Creates worktree `name` on a new branch `name` (default: a random name no branch or worktree folder uses) from
	 * `base` (default: what the main worktree has checked out), under the data directory's `worktrees/`.
	 */
	createWorktree(project: Project, name: string | undefined, base: string | undefined): Promise<Workspace> {
		return this.#serial(project.id, async () => {
			const branch = name ?? (await this.#unusedName(project));
			if (!(await isBranchName(project.path, branch))) throw new RangeError(`Invalid branch name: ${branch}`);
			const main = (await listWorktrees(project.path))[0];
			const from = base ?? main?.branch ?? main?.head;
			if (from === undefined) throw new Error(`${project.name}: no base to branch from`);
			const path = this.#worktreePath(project, branch);
			await addWorktree(project.path, path, branch, from);
			const created = (await this.workspaces(project)).find((workspace) => workspace.id === pathId(path));
			if (created === undefined) throw new Error(`git did not list the new worktree at ${path}`);
			return created;
		});
	}

	#worktreePath(project: Project, branch: string): string {
		return join(this.#dir.worktreesDir, `${project.name}-${project.id.slice(0, 6)}`, branch.replaceAll("/", "-"));
	}

	/** A random name free as a branch and as a worktree folder; with a number appended after a few collisions. */
	async #unusedName(project: Project): Promise<string> {
		for (let attempt = 0; ; attempt++) {
			const name = attempt < 8 ? randomName() : `${randomName()}-${attempt}`;
			if (!(await branchExists(project.path, name)) && !existsSync(this.#worktreePath(project, name))) return name;
		}
	}

	/** Removes a linked worktree; git refuses one with changes unless `force`. */
	removeWorktree(workspace: Workspace, force: "force" | "safe"): Promise<void> {
		const project = this.get(workspace.projectId);
		if (project === undefined) throw new Error("Unknown project");
		if (workspace.main) throw new RangeError("The main worktree cannot be removed");
		return this.#serial(project.id, async () => {
			await removeWorktree(project.path, workspace.path, force);
			await this.workspaces(project);
		});
	}

	#serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const result = (this.#queues.get(key) ?? Promise.resolve()).then(fn, fn);
		this.#queues.set(
			key,
			result.catch(() => {}),
		);
		return result;
	}

	#save(): void {
		writeFileSync(this.#dir.projectsFile, `${JSON.stringify(this.#projects, null, "\t")}\n`, "utf8");
	}
}

function load(file: string): Project[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const parsed: unknown = JSON.parse(text);
	// Trust boundary: a file the user may edit.
	if (!Array.isArray(parsed)) throw new Error(`${file}: expected an array of projects`);
	return parsed.filter(
		(each): each is Project =>
			typeof each?.id === "string" && typeof each?.name === "string" && typeof each?.path === "string",
	);
}
