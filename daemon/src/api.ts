// The HTTP API: JSON commands for projects, worktrees and each workspace's agent. Live state (the transcript, the
// running answer and tool output) goes over the WebSocket instead (socket.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	type Conversation,
	ConversationBusy,
	ConversationIdle,
	type ConversationId,
	type Cursor,
	type EntryId,
} from "@earendil-works/pi-durable";
import type { Validator } from "@earendil-works/pi-schema";
import type { Access } from "./access.ts";
import { GitError } from "./git.ts";
import type { AgentDefaults } from "./models.ts";
import { listDirectory } from "./directories.ts";
import { readGlobalInstructions, writeGlobalInstructions } from "./global-instructions.ts";
import { FileResponse, sendFile, worktreeImage } from "./workspace-files.ts";
import type { Projects, Workspace } from "./projects.ts";
import {
	AddProject,
	Compact,
	Configure,
	CreateWorktree,
	type DirectoryListing,
	type ModelListing,
	type GlobalInstructions,
	type ProjectListing,
	Reset,
	SaveInstructions,
	Submit,
	type WorkspaceDetail,
	type WorkspaceListing,
} from "./protocol.ts";
import { message, type OpenWorkspace, type WorkspaceHosts } from "./workspaces.ts";

export type ApiDeps = {
	readonly access: Access;
	readonly projects: Projects;
	readonly hosts: WorkspaceHosts;
	readonly models: () => Models;
	readonly defaults: () => AgentDefaults;
	/** pi's agent directory, holding the global instruction file. */
	readonly agentDir: string;
};

/** A refusal with its HTTP status. */
class HttpError extends Error {
	readonly status: number;
	constructor(status: number, text: string) {
		super(text);
		this.status = status;
	}
}

type Request = { readonly url: URL; readonly params: readonly string[]; body<T>(validator: Validator<T>): Promise<T> };
type Route = {
	readonly method: string;
	readonly pattern: RegExp;
	readonly handle: (request: Request) => Promise<unknown>;
};

/** Images make bodies large; anything beyond this is refused. */
const MAX_BODY = 64 * 1024 * 1024;

/** The request handler of the API under `/api/`. */
export function createApi(deps: ApiDeps): (request: IncomingMessage, response: ServerResponse) => void {
	const routes = apiRoutes(deps);
	return (request, response) => {
		void handle(deps, routes, request, response);
	};
}

async function handle(
	deps: ApiDeps,
	routes: readonly Route[],
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	try {
		const refusal = deps.access.refusal(request);
		if (refusal) throw new HttpError(403, refusal);
		const url = new URL(request.url ?? "/", "http://localhost");
		const route = routes.find((each) => each.method === request.method && each.pattern.test(url.pathname));
		if (route === undefined) throw new HttpError(404, "Not found");
		const params = (route.pattern.exec(url.pathname) ?? []).slice(1).map(decodeURIComponent);
		const result = await route.handle({ url, params, body: (validator) => readBody(request, validator) });
		if (result instanceof FileResponse) sendFile(response, result);
		else send(response, 200, result ?? { ok: true });
	} catch (error) {
		const status = statusOf(error);
		if (status === 500) console.error("flowie: request failed:", error);
		send(response, status, { error: message(error) });
	}
}

function apiRoutes({ projects, hosts, models, defaults, agentDir }: ApiDeps): Route[] {
	const workspaceOf = async (id: string): Promise<Workspace> => {
		const workspace = await projects.workspace(id);
		if (workspace === undefined) throw new HttpError(404, "Unknown workspace");
		return workspace;
	};
	const openWorkspace = async (id: string): Promise<OpenWorkspace> => {
		const workspace = await workspaceOf(id);
		return hosts.use(workspace.id, workspace.path);
	};
	const projectOf = (id: string) => {
		const project = projects.get(id);
		if (project === undefined) throw new HttpError(404, "Unknown project");
		return project;
	};
	const listProject = async (project: ReturnType<typeof projectOf>): Promise<ProjectListing> => {
		try {
			const workspaces = await projects.workspaces(project);
			return {
				...project,
				workspaces: workspaces.map((workspace) => ({ ...workspace, status: hosts.status(workspace.id) })),
			};
		} catch (error) {
			return { ...project, workspaces: [], error: message(error) };
		}
	};

	return [
		{ method: "GET", pattern: /^\/api\/health$/, handle: async () => ({ ok: true }) },
		{
			method: "GET",
			pattern: /^\/api\/projects$/,
			handle: async () => ({ projects: await Promise.all(projects.list().map(listProject)) }),
		},
		{
			method: "POST",
			pattern: /^\/api\/projects$/,
			handle: async (request) => listProject(await projects.add((await request.body(AddProject)).path)),
		},
		{
			method: "DELETE",
			pattern: /^\/api\/projects\/([^/]+)$/,
			handle: async ({ params: [id] }) => {
				if (!projects.remove(id!)) throw new HttpError(404, "Unknown project");
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/projects\/([^/]+)\/worktrees$/,
			handle: async (request): Promise<WorkspaceListing> => {
				const { name, base } = await request.body(CreateWorktree);
				const workspace = await projects.createWorktree(projectOf(request.params[0]!), name, base);
				return { ...workspace, status: hosts.status(workspace.id) };
			},
		},
		{
			method: "DELETE",
			pattern: /^\/api\/workspaces\/([^/]+)$/,
			handle: async ({ url, params: [id] }) => {
				const workspace = await workspaceOf(id!);
				// Close first: the agent's processes must not hold files git is about to delete.
				await hosts.close(workspace.id);
				await projects.removeWorktree(workspace, url.searchParams.get("force") === "1" ? "force" : "safe");
				await hosts.archive(workspace.id);
			},
		},
		{
			method: "GET",
			pattern: /^\/api\/directories$/,
			handle: async ({ url }): Promise<DirectoryListing> =>
				listDirectory(
					url.searchParams.get("path") ?? undefined,
					projects.list().map((project) => dirname(project.path)),
				),
		},
		{
			method: "GET",
			pattern: /^\/api\/instructions$/,
			handle: async (): Promise<GlobalInstructions> => readGlobalInstructions(agentDir),
		},
		{
			method: "PUT",
			pattern: /^\/api\/instructions$/,
			handle: async (request): Promise<GlobalInstructions> =>
				writeGlobalInstructions(agentDir, (await request.body(SaveInstructions)).content),
		},
		{
			method: "GET",
			pattern: /^\/api\/models$/,
			handle: async (): Promise<ModelListing> => ({
				defaults: defaults(),
				models: (await models().getAvailable()).map((model) => ({
					provider: model.provider,
					id: model.id,
					name: model.name,
					reasoning: model.reasoning,
					input: model.input,
					contextWindow: model.contextWindow,
				})),
			}),
		},
		{
			method: "GET",
			pattern: /^\/api\/workspaces\/([^/]+)$/,
			handle: async ({ params: [id] }): Promise<WorkspaceDetail> => {
				const workspace = await workspaceOf(id!);
				const open = await hosts.use(workspace.id, workspace.path);
				const agent = await open.root.agent(BACKGROUND_CONTEXT);
				return {
					...workspace,
					status: hosts.status(workspace.id),
					agent: { model: agent.model, thinkingLevel: agent.thinkingLevel, cwd: agent.cwd },
					usage: await open.harness.usage(BACKGROUND_CONTEXT),
				};
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/workspaces\/([^/]+)\/agent$/,
			handle: async (request) => {
				const change = await request.body(Configure);
				const open = await openWorkspace(request.params[0]!);
				if (change.model) {
					const known = models().getModel(change.model.provider, change.model.modelId);
					if (known === undefined) throw new HttpError(400, "Unknown model");
				}
				await open.root.configure(change, BACKGROUND_CONTEXT);
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/workspaces\/([^/]+)\/submit$/,
			handle: async (request) => {
				const input = await request.body(Submit);
				const { root } = await openWorkspace(request.params[0]!);
				const submission = await root.submit(
					{
						type: "input",
						content: input.content,
						...(input.whenBusy === undefined ? {} : { whenBusy: input.whenBusy }),
						...(input.requestId === undefined ? {} : { requestId: input.requestId }),
					},
					BACKGROUND_CONTEXT,
				);
				return { submission: submission.id };
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/workspaces\/([^/]+)\/continue$/,
			handle: async ({ params: [id] }) => {
				const { root } = await openWorkspace(id!);
				return { submission: (await root.submit({ type: "continue" }, BACKGROUND_CONTEXT)).id };
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/workspaces\/([^/]+)\/abort$/,
			handle: async ({ params: [id] }) => {
				const { root } = await openWorkspace(id!);
				await root.abort(BACKGROUND_CONTEXT);
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/workspaces\/([^/]+)\/compact$/,
			handle: async (request) => {
				const { instructions } = await request.body(Compact);
				const { root } = await openWorkspace(request.params[0]!);
				return { task: await root.compact(instructions, BACKGROUND_CONTEXT) };
			},
		},
		{
			method: "POST",
			pattern: /^\/api\/workspaces\/([^/]+)\/reset$/,
			handle: async (request) => {
				const { handoff } = await request.body(Reset);
				const { root } = await openWorkspace(request.params[0]!);
				await root.reset(handoff, BACKGROUND_CONTEXT);
			},
		},
		{
			// An image of the worktree, for Markdown images the agent writes with a file path.
			method: "GET",
			pattern: /^\/api\/workspaces\/([^/]+)\/file$/,
			handle: async ({ url, params: [id] }) => {
				const path = url.searchParams.get("path");
				if (!path) throw new HttpError(400, "A path is required");
				const image = await worktreeImage((await workspaceOf(id!)).path, path);
				if (!(image instanceof FileResponse)) throw new HttpError(image.status, image.message);
				return image;
			},
		},
		{
			// History outside a watch's window, between the inclusive bounds `min` and `max`; newest first unless
			// `order=ascending`.
			method: "GET",
			pattern: /^\/api\/workspaces\/([^/]+)\/entries$/,
			handle: async ({ url, params: [workspace] }) => {
				const open = await openWorkspace(workspace!);
				const id = url.searchParams.get("conversation");
				const conversation = await conversationOf(open, id === null ? undefined : wireId(id));
				const min = url.searchParams.get("min");
				const max = url.searchParams.get("max");
				const order = url.searchParams.get("order");
				const cursor = url.searchParams.get("cursor");
				const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 500);
				const page = await conversation.entries(
					{
						...(min === null ? {} : { minEntryId: wireId(min) as EntryId }),
						...(max === null ? {} : { maxEntryId: wireId(max) as EntryId }),
						...(order === "ascending" || order === "descending" ? { order } : {}),
					},
					limit,
					cursor === null ? undefined : decodeCursor(cursor),
					BACKGROUND_CONTEXT,
				);
				return {
					items: page.items,
					...(page.next === undefined ? {} : { next: Buffer.from(JSON.stringify(page.next)).toString("base64url") }),
				};
			},
		},
	];
}

/** The workspace's agent, or another of its conversations (a subagent's) by ID. */
export async function conversationOf(open: OpenWorkspace, id: number | undefined): Promise<Conversation> {
	if (id === undefined) return open.root;
	// Wire input: an unknown ID finds nothing.
	const conversation = await open.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
	if (conversation === undefined) throw new HttpError(404, "Unknown conversation");
	return conversation;
}

/** A Durable ID from a query parameter: a non-negative integer. */
function wireId(text: string): number {
	const id = Number(text);
	if (!Number.isSafeInteger(id) || id < 0) throw new HttpError(400, `Invalid ID: ${text}`);
	return id;
}

function decodeCursor(text: string): Cursor {
	try {
		return JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Cursor;
	} catch {
		throw new HttpError(400, "Invalid cursor");
	}
}

async function readBody<T>(request: IncomingMessage, validator: Validator<T>): Promise<T> {
	if (!/^application\/json\b/.test(request.headers["content-type"] ?? ""))
		throw new HttpError(415, "Expected application/json");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > MAX_BODY) throw new HttpError(413, "Body too large");
		chunks.push(chunk);
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "Invalid JSON");
	}
	if (validator.check(value)) return value;
	const errors = validator.errors(value).map((error) => `${error.path || "/"}: ${error.message}`);
	throw new HttpError(400, `Invalid body: ${errors.join("; ")}`);
}

function statusOf(error: unknown): number {
	if (error instanceof HttpError) return error.status;
	if (error instanceof ConversationBusy || error instanceof ConversationIdle) return 409;
	if (error instanceof GitError || error instanceof RangeError) return 400;
	return 500;
}

function send(response: ServerResponse, status: number, body: unknown): void {
	if (response.headersSent) return;
	const text = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
		"cache-control": "no-store",
	});
	response.end(text);
}
