// The review diff: git's view of a worktree against its base, untracked files included.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { diffBase, diffContents, worktreeDiff } from "../src/diff.ts";

const run = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

describe("worktree diff", () => {
	let root: string;
	let repo: string;
	let worktree: string;

	before(() => {
		root = mkdtempSync(join(tmpdir(), "flowie-diff-test-"));
		repo = join(root, "repo");
		worktree = join(root, "feature");
		execFileSync("git", ["init", "-q", "-b", "main", repo]);
		for (const [key, value] of [
			["user.email", "test@example.com"],
			["user.name", "test"],
			["core.autocrlf", "false"],
		] as const)
			run(repo, "config", key, value);
		writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
		writeFileSync(join(repo, "gone.txt"), "bye\n");
		writeFileSync(join(repo, "old-name.txt"), "same\nlines\nhere\n");
		writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
		run(repo, "add", ".");
		run(repo, "commit", "-qm", "init");
		run(repo, "worktree", "add", "-q", "-b", "feature", worktree, "main");
		// Committed on the branch, then more changes on disk on top.
		writeFileSync(join(worktree, "app.ts"), "export const a = 2;\n");
		run(worktree, "commit", "-qam", "wip");
		writeFileSync(join(worktree, "app.ts"), "export const a = 2;\nexport const b = 3;\n");
		run(worktree, "rm", "-q", "gone.txt");
		run(worktree, "mv", "old-name.txt", "new-name.txt");
		writeFileSync(join(worktree, "untracked.ts"), "export {};\n");
		writeFileSync(join(worktree, "ignored.txt"), "not shown\n");
	});

	after(() => rmSync(root, { recursive: true, force: true }));

	it("measures a linked worktree from where it branched off the main checkout's branch", async () => {
		const base = await diffBase({ path: worktree, main: false }, { path: repo, main: true, branch: "main" });
		assert.equal(base.commit, run(repo, "rev-parse", "main"));
		assert.equal(base.label, "main");
		const own = await diffBase({ path: repo, main: true, branch: "main" }, { path: repo, main: true, branch: "main" });
		assert.deepEqual(own, { commit: run(repo, "rev-parse", "HEAD"), label: "HEAD" });
	});

	it("lists committed, uncommitted and untracked changes without touching the index", async () => {
		const base = run(repo, "rev-parse", "main");
		const status = run(worktree, "status", "--porcelain");
		const files = await worktreeDiff(worktree, base);
		const byPath = new Map(files.map((file) => [file.path, file]));
		assert.deepEqual([...byPath.keys()].sort(), ["app.ts", "gone.txt", "new-name.txt", "untracked.ts"]);
		assert.equal(byPath.get("app.ts")?.status, "modified");
		assert.match(byPath.get("app.ts")!.patch, /^-export const a = 1;$/m);
		assert.match(byPath.get("app.ts")!.patch, /^\+export const b = 3;$/m);
		assert.equal(byPath.get("gone.txt")?.status, "deleted");
		assert.deepEqual(
			{ status: byPath.get("new-name.txt")?.status, oldPath: byPath.get("new-name.txt")?.oldPath },
			{ status: "renamed", oldPath: "old-name.txt" },
		);
		assert.equal(byPath.get("untracked.ts")?.status, "added");
		assert.match(byPath.get("untracked.ts")!.patch, /^\+export \{\};$/m);
		assert.equal(run(worktree, "status", "--porcelain"), status, "the real index is unchanged");
	});

	it("reads both sides of a file, and refuses paths outside the worktree", async () => {
		const base = run(repo, "rev-parse", "main");
		assert.deepEqual(await diffContents(worktree, base, "app.ts", undefined), {
			oldFile: "export const a = 1;\n",
			newFile: "export const a = 2;\nexport const b = 3;\n",
		});
		assert.deepEqual(await diffContents(worktree, base, "untracked.ts", undefined), {
			oldFile: null,
			newFile: "export {};\n",
		});
		assert.deepEqual(await diffContents(worktree, base, "gone.txt", undefined), { oldFile: "bye\n", newFile: null });
		await assert.rejects(diffContents(worktree, base, "../repo/app.ts", undefined), /Outside the worktree/);
		await assert.rejects(diffContents(worktree, "main", "app.ts", undefined), /Invalid base/);
	});
});
