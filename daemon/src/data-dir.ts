// The daemon's data directory layout, and the lock that keeps a second daemon from writing the same files.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DataDir = {
	readonly root: string;
	/** Registered projects (`projects.json`). */
	readonly projectsFile: string;
	/** flowie's settings (`settings.json`), such as the default model; optional. */
	readonly settingsFile: string;
	/** One directory per workspace (worktree): its Harness storage and `meta.json`. */
	readonly workspacesDir: string;
	/** Where worktrees the daemon creates are checked out: `<worktreesDir>/<project>/<name>`. */
	readonly worktreesDir: string;
	/** Workspace data of removed worktrees, kept instead of deleted. */
	readonly archiveDir: string;
};

/** `FLOWIE_DATA_DIR`, else `~/.flowie`. */
export function defaultDataDir(): string {
	return process.env.FLOWIE_DATA_DIR ?? join(homedir(), ".flowie");
}

/** The layout under `root`, created if missing. */
export function openDataDir(root: string): DataDir {
	const dir: DataDir = {
		root,
		projectsFile: join(root, "projects.json"),
		settingsFile: join(root, "settings.json"),
		workspacesDir: join(root, "workspaces"),
		worktreesDir: join(root, "worktrees"),
		archiveDir: join(root, "archive"),
	};
	for (const path of [dir.root, dir.workspacesDir, dir.worktreesDir, dir.archiveDir])
		mkdirSync(path, { recursive: true, mode: 0o700 });
	return dir;
}

/**
 * Takes `<root>/daemon.lock` for this process and returns its release. Durable storage has no cross-process locking,
 * so two daemons on one data directory would corrupt each other's commits. A lock left by a dead process is taken over.
 */
export function takeProcessLock(root: string): () => void {
	const path = join(root, "daemon.lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, String(process.pid), { flag: "wx" });
			return () => {
				try {
					unlinkSync(path);
				} catch {
					// Already gone.
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const holder = Number(readFileSync(path, "utf8").trim());
			if (Number.isInteger(holder) && holder > 0 && isAlive(holder))
				throw new Error(`Another flowie daemon (pid ${holder}) uses ${root}`);
			unlinkSync(path);
		}
	}
	throw new Error(`Could not take ${path}`);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
