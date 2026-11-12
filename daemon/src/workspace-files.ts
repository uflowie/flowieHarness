// Images from a worktree for the browser: what the agent shows with Markdown such as `![chart](out/chart.png)`. The
// files are on the daemon's machine, which may not be the browser's, so the daemon serves them. Only images, and only
// inside the worktree.
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
};

const MAX_BYTES = 50 * 1024 * 1024;

/** An image file to stream as the response, instead of JSON. */
export class FileResponse {
	readonly path: string;
	readonly type: string;
	readonly size: number;
	constructor(path: string, type: string, size: number) {
		this.path = path;
		this.type = type;
		this.size = size;
	}
}

/**
 * The image at `path` (relative to the worktree, or absolute inside it), or why it cannot be served: a status and a
 * message. Symbolic links are followed before the check, so a link cannot lead outside the worktree.
 */
export async function worktreeImage(
	worktree: string,
	path: string,
): Promise<FileResponse | { readonly status: number; readonly message: string }> {
	const type = IMAGE_TYPES[extname(path).toLowerCase()];
	if (type === undefined) return { status: 415, message: "Only image files are served" };
	let file: string;
	let root: string;
	try {
		root = await realpath(worktree);
		file = await realpath(resolve(worktree, path));
	} catch {
		return { status: 404, message: "No such file" };
	}
	// Wire input: the path must stay inside the worktree.
	const inside = relative(root, file);
	if (inside.startsWith("..") || isAbsolute(inside)) return { status: 403, message: "Outside the worktree" };
	const info = await stat(file);
	if (!info.isFile()) return { status: 404, message: "No such file" };
	if (info.size > MAX_BYTES) return { status: 413, message: "Image too large" };
	return new FileResponse(file, type, info.size);
}

/** Streams `file`; scripts in it never run, even when it is opened directly (an SVG). */
export function sendFile(response: ServerResponse, file: FileResponse): void {
	response.writeHead(200, {
		"content-type": file.type,
		"content-length": file.size,
		"cache-control": "no-cache",
		"content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
		"x-content-type-options": "nosniff",
	});
	createReadStream(file.path).pipe(response);
}
