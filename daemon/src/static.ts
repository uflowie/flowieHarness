// Serves the built web UI (`web/dist`) for every path outside `/api/`, with `index.html` for client-side routes.
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { Access } from "./access.ts";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

/** The handler for `root`; it answers 404 with a hint when the UI was not built. */
export function serveStatic(root: string, access: Access): (request: IncomingMessage, response: ServerResponse) => void {
	const base = resolve(root);
	return (request, response) => {
		const refusal = access.refusal(request);
		if (refusal) return void response.writeHead(403).end(refusal);
		if (request.method !== "GET" && request.method !== "HEAD") return void response.writeHead(405).end();
		const index = join(base, "index.html");
		if (!existsSync(index)) {
			response.writeHead(404, { "content-type": "text/plain" });
			return void response.end("The web UI is not built: run `npm run build -w web`, or `npm run dev` for development.");
		}
		const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
		const file = resolve(base, `.${path}`);
		// Wire input: a path must stay inside the UI directory.
		const inside = file === base || file.startsWith(base + sep);
		const found = inside && existsSync(file) && statSync(file).isFile() ? file : index;
		response.writeHead(200, {
			"content-type": TYPES[extname(found)] ?? "application/octet-stream",
			// Vite fingerprints assets; the page itself must be fetched fresh to pick up new builds.
			"cache-control": found.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
		});
		if (request.method === "HEAD") return void response.end();
		createReadStream(found).pipe(response);
	};
}
