// A worktree's changes for review: git's diff of the files on disk against the commit the worktree started from,
// untracked files included.
//
// Untracked files are listed by `git add --intent-to-add` into a copy of the worktree's index, so they show as new
// files without touching the real index or writing objects into the repository.
import { copyFile, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { GitError, git } from "./git.ts";
import type { DiffContents, DiffFile, WorkspaceDiff } from "./protocol.ts";

/** A file's patch beyond this is left out; the browser shows the file without its lines. */
const MAX_FILE_PATCH = 4 * 1024 * 1024;
/** Every patch together; beyond this each file is listed without its lines. */
const MAX_PATCH = 128 * 1024 * 1024;
const MAX_CONTENTS_BYTES = 32 * 1024 * 1024;

// Flags that keep git's output parseable whatever the user's configuration says about prefixes, colors and tools.
const CONFIG = ["-c", "core.quotePath=false"];
const DIFF_FLAGS = [
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--no-relative",
	"--find-renames",
	"--src-prefix=a/",
	"--dst-prefix=b/",
];

/** A checkout as the diff needs it: a worktree, and whether it is the repository's main one. */
export type Checkout = { readonly path: string; readonly main: boolean; readonly branch?: string; readonly head?: string };

/**
 * The commit a worktree's changes are measured against: where it branched off what the main checkout has checked
 * out, or for the main checkout itself, HEAD.
 */
export async function diffBase(worktree: Checkout, main: Checkout | undefined): Promise<WorkspaceDiff["base"]> {
	const head = (await git(["rev-parse", "--verify", "HEAD"], worktree.path)).trim();
	const ref = main?.branch ?? main?.head;
	if (worktree.main || ref === undefined) return { commit: head, label: "HEAD" };
	try {
		const commit = (await git(["merge-base", "HEAD", ref], worktree.path)).trim();
		return { commit, label: main?.branch ?? ref.slice(0, 8) };
	} catch {
		// Unrelated histories: no common commit to start from.
		return { commit: head, label: "HEAD" };
	}
}

/** Every file of the worktree at `path` that differs from commit `base`, with its patch. */
export async function worktreeDiff(path: string, base: string): Promise<DiffFile[]> {
	const temp = await mkdtemp(join(tmpdir(), "flowie-diff-"));
	try {
		const env = { ...process.env, GIT_INDEX_FILE: join(temp, "index") };
		const index = resolve(path, (await git(["rev-parse", "--git-path", "index"], path)).trim());
		// A repository without a commit has no index yet; `add` makes one.
		await copyFile(index, env.GIT_INDEX_FILE).catch(() => {});
		await git(["add", "--all", "--intent-to-add", "--ignore-errors"], path, { env });
		const files = parseNameStatus(await git([...CONFIG, "diff", ...DIFF_FLAGS, "--name-status", "-z", base], path, { env }));
		let patch: string | undefined;
		try {
			patch = await git([...CONFIG, "diff", ...DIFF_FLAGS, base], path, { env, maxBuffer: MAX_PATCH });
		} catch (error) {
			if (!(error instanceof GitError && error.overflow)) throw error;
		}
		return attachPatches(files, patch);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}

type Listed = Pick<DiffFile, "path" | "oldPath" | "status">;

/** `git diff --name-status -z`: a status, then one path, or two for a rename or copy. */
function parseNameStatus(out: string): Listed[] {
	const fields = out.split("\0");
	const files: Listed[] = [];
	for (let index = 0; index < fields.length; ) {
		const status = fields[index];
		if (!status) break;
		if (status.startsWith("R") || status.startsWith("C")) {
			const [oldPath, path] = [fields[index + 1], fields[index + 2]];
			index += 3;
			if (oldPath === undefined || path === undefined) break;
			files.push({ path, oldPath, status: "renamed" });
			continue;
		}
		const path = fields[index + 1];
		index += 2;
		if (path === undefined) break;
		files.push({ path, status: status === "A" ? "added" : status === "D" ? "deleted" : "modified" });
	}
	return files;
}

/** Gives each listed file its part of git's patch, by the `diff --git` line that starts it. */
function attachPatches(files: readonly Listed[], patch: string | undefined): DiffFile[] {
	const chunks = new Map<string, string>();
	for (const chunk of patch?.split(/^(?=diff --git )/m) ?? []) {
		const header = chunk.slice(0, chunk.indexOf("\n")).trimEnd();
		if (header.startsWith("diff --git ")) chunks.set(header, chunk);
	}
	return files.map((file) => {
		const header = `diff --git a/${file.oldPath ?? file.path} b/${file.path}`;
		const chunk = chunks.get(header);
		if (chunk === undefined) {
			// Too large altogether, or a name git quotes in its headers: the file without its lines.
			return { ...file, patch: `${header}\n`, binary: false, ...(patch === undefined ? { omitted: 0 } : {}) };
		}
		const binary = /^(Binary files .* differ|GIT binary patch)$/m.test(chunk);
		if (chunk.length <= MAX_FILE_PATCH) return { ...file, patch: chunk, binary };
		const hunks = chunk.search(/^@@ /m);
		return { ...file, patch: hunks === -1 ? `${header}\n` : chunk.slice(0, hunks), binary, omitted: chunk.length };
	});
}

/** The old and new text of a changed file, for expanding unchanged lines; `null` for a side that does not exist. */
export async function diffContents(
	worktree: string,
	base: string,
	path: string,
	oldPath: string | undefined,
): Promise<DiffContents> {
	// Wire input: a commit ID, and a new side inside the worktree.
	if (!/^[0-9a-f]{40,64}$/.test(base)) throw new RangeError("Invalid base commit");
	const oldFile = await git(["cat-file", "blob", `${base}:${oldPath ?? path}`], worktree, {
		maxBuffer: MAX_CONTENTS_BYTES,
	}).catch(() => null);
	let newFile: string | null = null;
	try {
		const root = await realpath(worktree);
		const file = await realpath(resolve(worktree, path));
		const inside = relative(root, file);
		if (inside.startsWith("..") || isAbsolute(inside)) throw new RangeError("Outside the worktree");
		const buffer = await readFile(file);
		if (buffer.length > MAX_CONTENTS_BYTES) throw new RangeError("File too large");
		newFile = buffer.toString("utf8");
	} catch (error) {
		if (error instanceof RangeError) throw error;
		// Deleted: no new side.
	}
	return { oldFile, newFile };
}
