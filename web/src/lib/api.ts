// Typed calls of the daemon's HTTP API.
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { EntryRecord, ModelRef } from "@earendil-works/pi-durable";
import type {
	DirectoryListing,
	ModelListing,
	ProjectListing,
	Submit,
	WorkspaceListing,
} from "@flowie/daemon/protocol";

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	const json = await response.json().catch(() => ({ error: response.statusText }));
	if (!response.ok) throw new ApiError(response.status, (json as { error?: string }).error ?? response.statusText);
	return json as T;
}

const workspacePath = (id: string, rest = "") => `/api/workspaces/${encodeURIComponent(id)}${rest}`;

export type EntryQuery = {
	readonly min?: number;
	readonly max?: number;
	readonly order?: "ascending" | "descending";
	readonly limit: number;
	readonly conversation?: number;
};

export const api = {
	projects: () => call<{ projects: ProjectListing[] }>("GET", "/api/projects").then((reply) => reply.projects),
	addProject: (path: string) => call<ProjectListing>("POST", "/api/projects", { path }),
	removeProject: (id: string) => call<unknown>("DELETE", `/api/projects/${encodeURIComponent(id)}`),
	/** Without a name, the daemon picks a random one. */
	createWorktree: (project: string, name: string | undefined) =>
		call<WorkspaceListing>("POST", `/api/projects/${encodeURIComponent(project)}/worktrees`, name ? { name } : {}),
	removeWorktree: (id: string, force: boolean) => call<unknown>("DELETE", workspacePath(id, force ? "?force=1" : "")),
	directories: (path: string | undefined) =>
		call<DirectoryListing>("GET", `/api/directories${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`),
	models: () => call<ModelListing>("GET", "/api/models"),
	configure: (id: string, change: { model?: ModelRef | null; thinkingLevel?: ModelThinkingLevel | null }) =>
		call<unknown>("POST", workspacePath(id, "/agent"), change),
	submit: (id: string, input: Submit) => call<{ submission: number }>("POST", workspacePath(id, "/submit"), input),
	continue: (id: string) => call<unknown>("POST", workspacePath(id, "/continue")),
	abort: (id: string) => call<unknown>("POST", workspacePath(id, "/abort")),
	compact: (id: string) => call<unknown>("POST", workspacePath(id, "/compact"), {}),
	reset: (id: string) => call<unknown>("POST", workspacePath(id, "/reset"), {}),
	entries: (id: string, query: EntryQuery) => {
		const params = new URLSearchParams({ limit: String(query.limit) });
		for (const key of ["min", "max", "order", "conversation"] as const)
			if (query[key] !== undefined) params.set(key, String(query[key]));
		return call<{ items: EntryRecord[] }>("GET", workspacePath(id, `/entries?${params}`));
	},
};
