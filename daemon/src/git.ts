// The git commands the daemon runs: finding a repository's main worktree, and listing, adding and removing worktrees.
import { execFile } from "node:child_process";
import { resolve } from "node:path";

export type Worktree = {
	readonly path: string;
	/** Commit checked out; absent in a bare repository. */
	readonly head?: string;
	/** Short branch name; absent when detached. */
	readonly branch?: string;
	/** The repository's main worktree (git lists it first). */
	readonly main: boolean;
	/** Git can prune it: its directory is gone. */
	readonly prunable: boolean;
};

export class GitError extends Error {
	readonly stderr: string;
	/** Git wrote more than the call's `maxBuffer` and was stopped. */
	readonly overflow: boolean;
	constructor(args: readonly string[], stderr: string, overflow = false) {
		super(`git ${args.join(" ")}: ${overflow ? "output too large" : stderr.trim() || "failed"}`);
		this.stderr = stderr;
		this.overflow = overflow;
	}
}

export type GitOptions = {
	/** Replaces the environment (default: the daemon's). */
	readonly env?: NodeJS.ProcessEnv;
	/** Bytes of stdout beyond which git is stopped and the call fails (default 16 MiB). */
	readonly maxBuffer?: number;
};

/** Runs git in `cwd` and resolves with its stdout. */
export function git(args: readonly string[], cwd: string, options: GitOptions = {}): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			"git",
			args,
			{ cwd, env: options.env, maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				const overflow = (error as { code?: unknown } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
				if (error) reject(new GitError(args, stderr || error.message, overflow));
				else resolvePromise(stdout);
			},
		);
	});
}

/** The worktrees of the repository at `repo`, main first, from `git worktree list --porcelain`. */
export async function listWorktrees(repo: string): Promise<Worktree[]> {
	const out = await git(["worktree", "list", "--porcelain", "-z"], repo);
	const worktrees: Worktree[] = [];
	// Records are separated by an empty field; each field is `key value` or a bare `key`.
	for (const record of out.split("\0\0")) {
		const fields = record.split("\0").filter(Boolean);
		const path = field(fields, "worktree");
		if (path === undefined || fields.includes("bare")) continue;
		const head = field(fields, "HEAD");
		const branch = field(fields, "branch")?.replace(/^refs\/heads\//, "");
		worktrees.push({
			path: resolve(path),
			...(head === undefined ? {} : { head }),
			...(branch === undefined ? {} : { branch }),
			main: worktrees.length === 0,
			prunable: fields.some((each) => each === "prunable" || each.startsWith("prunable ")),
		});
	}
	return worktrees;
}

function field(fields: readonly string[], key: string): string | undefined {
	const found = fields.find((each) => each.startsWith(`${key} `));
	return found?.slice(key.length + 1);
}

/** The main worktree of the repository containing `path`; throws when `path` is not in a git repository. */
export async function mainWorktree(path: string): Promise<string> {
	const [main] = await listWorktrees(path);
	if (main === undefined) throw new GitError(["worktree", "list"], `${path} has no worktree (bare repository?)`);
	return main.path;
}

/** Checks out a new branch `branch` from `base` at `path`. */
export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
	await git(["worktree", "add", "-b", branch, path, base], repo);
}

/** Removes the worktree at `path`; without `force`, git refuses one with changes. */
export async function removeWorktree(repo: string, path: string, force: "force" | "safe"): Promise<void> {
	await git(["worktree", "remove", ...(force === "force" ? ["--force"] : []), path], repo);
}

/** Whether the repository at `repo` has a local branch `name`. */
export async function branchExists(repo: string, name: string): Promise<boolean> {
	try {
		await git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], repo);
		return true;
	} catch {
		return false;
	}
}

/** Whether `name` is a valid new branch name, by `git check-ref-format`. */
export async function isBranchName(repo: string, name: string): Promise<boolean> {
	try {
		await git(["check-ref-format", "--branch", name], repo);
		return true;
	} catch {
		return false;
	}
}
