// Directory listings for the UI's "add repository" browser. They come from the daemon's file system, which may not be
// the browser's (the daemon in WSL, the browser on Windows), so the UI cannot use the browser's file picker.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DirectoryListing } from "./protocol.ts";

const MAX_ENTRIES = 1000;

/** The folders in `path` (default: home; `~` is home), git repositories marked, with shortcuts to elsewhere. */
export function listDirectory(path: string | undefined, places: readonly string[]): DirectoryListing {
	const home = homedir();
	const target = resolve(home, (path ?? "").replace(/^~(?=$|[\\/])/, home) || ".");
	const parent = dirname(target);
	const base = {
		path: target,
		...(parent === target ? {} : { parent }),
		repo: existsSync(join(target, ".git")),
		home,
		roots: roots(),
		places: [...new Set(places)].filter((place) => place !== home),
	};
	let names: string[];
	try {
		names = readdirSync(target, { withFileTypes: true })
			// Hidden folders are skipped: repositories rarely live in them.
			.filter((entry) => !entry.name.startsWith(".") && isDirectory(target, entry))
			.map((entry) => entry.name);
	} catch (error) {
		return { ...base, entries: [], error: (error as NodeJS.ErrnoException).code ?? "Cannot read this folder" };
	}
	const entries = names
		.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
		.slice(0, MAX_ENTRIES)
		.map((name) => ({ name, path: join(target, name), repo: existsSync(join(target, name, ".git")) }));
	return { ...base, entries };
}

function isDirectory(dir: string, entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return statSync(join(dir, entry.name)).isDirectory();
	} catch {
		return false;
	}
}

/** The file system roots: the drives that exist on Windows, `/` elsewhere. */
function roots(): string[] {
	if (process.platform !== "win32") return ["/"];
	return [..."CDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter) => `${letter}:\\`).filter((root) => existsSync(root));
}
