// End to end: a daemon on a temporary git repository with the faux model provider. Covers projects and worktrees, a
// streamed run with a tool call over the WebSocket, the Host/Origin guard, persistence across a restart, the process
// lock, and removing a worktree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView } from "@earendil-works/pi-durable";
import WebSocket from "ws";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import type { ServerMessage } from "../src/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "flowie-test-"));
const dataDir = join(root, "data");
const agentDir = join(root, "agent");
const repo = join(root, "repo");

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const defaults = { model: { provider: "faux", modelId: "faux-1" } };
const start = () => startDaemon({ dataDir, agentDir, models, defaults, port: 0 });

let daemon: Daemon;

before(async () => {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
	execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
	writeFileSync(join(repo, "README.md"), "# test repo\n");
	git("add", ".");
	git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "init");
	daemon = await start();
});

after(async () => {
	await daemon.close();
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("daemon", () => {
	let workspace: string;

	it("registers a project and creates a worktree", async () => {
		const project = await api("POST", "/api/projects", { path: repo });
		assert.equal(project.workspaces.length, 1);
		assert.equal(project.workspaces[0].main, true);
		const created = await api("POST", `/api/projects/${project.id}/worktrees`, { name: "feat-x" });
		assert.equal(created.branch, "feat-x");
		assert.ok(existsSync(join(created.path, "README.md")));
		workspace = created.id;
		const { projects } = await api("GET", "/api/projects");
		assert.equal(projects[0].workspaces.length, 2);
	});

	it("streams a run with a tool call over the WebSocket", async () => {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo hello-from-tool" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		const client = await connect();
		try {
			client.send({ type: "watch", sub: "agent", workspace });
			await client.until(() => client.view !== undefined);
			const { submission } = await api("POST", `/api/workspaces/${workspace}/submit`, { content: "run it" });
			assert.equal(typeof submission, "number");
			await client.until(() => lastAssistantText(client.view) === "Done." && client.status === "idle");
			const kinds = client.view!.entries.map((entry) => entry.kind);
			assert.deepEqual(kinds.filter((kind) => kind !== "pi.system"), [
				"pi.user",
				"pi.assistant",
				"pi.tool-result",
				"pi.assistant",
			]);
			const result = client.view!.entries.find((entry) => entry.kind === "pi.tool-result")?.model?.[0];
			assert.ok(result?.role === "toolResult" && !result.isError, "bash ran without error");
			assert.match(JSON.stringify(result.content), /hello-from-tool/);
			assert.doesNotMatch(JSON.stringify(result.content), /echo/);
			assert.ok(client.statuses.includes("busy"), "the sidebar saw the run");
		} finally {
			client.close();
		}
	});

	it("feeds a subscription from one watch when it is re-watched while setting up", async () => {
		// React's StrictMode mounts twice: watch, unwatch and watch of one name arrive back to back.
		faux.setResponses([fauxAssistantMessage("Only once.")]);
		const client = await connect();
		try {
			client.send({ type: "watch", sub: "agent", workspace });
			client.send({ type: "unwatch", sub: "agent" });
			client.send({ type: "watch", sub: "agent", workspace });
			await client.until(() => client.view !== undefined);
			await api("POST", `/api/workspaces/${workspace}/submit`, { content: "again" });
			await client.until(() => lastAssistantText(client.view) === "Only once." && client.status === "idle");
			assert.equal(client.values, 1, "one watch sent its first value");
		} finally {
			client.close();
		}
	});

	it("refuses foreign origins and hosts", async () => {
		assert.equal((await raw("/api/projects", { origin: "https://evil.example" })).status, 403);
		assert.equal((await raw("/api/projects", { host: "evil.example" })).status, 403);
		assert.equal((await raw("/api/projects", { origin: daemon.url })).status, 200);
	});

	it("rejects invalid bodies", async () => {
		const response = await raw(`/api/workspaces/${workspace}/submit`, {}, "POST", { content: 5 });
		assert.equal(response.status, 400);
	});

	it("keeps the transcript across a restart and holds the data directory lock", async () => {
		await assert.rejects(start(), /Another flowie daemon/);
		await daemon.close();
		daemon = await start();
		const client = await connect();
		try {
			client.send({ type: "watch", sub: "agent", workspace });
			await client.until(() => client.view !== undefined);
			assert.equal(lastAssistantText(client.view), "Only once.");
		} finally {
			client.close();
		}
		const page = await api("GET", `/api/workspaces/${workspace}/entries?limit=2`);
		assert.equal(page.items.length, 2);
		assert.equal(typeof page.next, "string");
	});

	it("removes a worktree and archives its data", async () => {
		const { projects } = await api("GET", "/api/projects");
		const path = projects[0].workspaces.find((each: { id: string }) => each.id === workspace).path;
		await api("DELETE", `/api/workspaces/${workspace}`);
		assert.equal(existsSync(path), false);
		assert.ok(readdirSync(join(dataDir, "archive")).some((name) => name.startsWith(workspace)));
		const after = await api("GET", "/api/projects");
		assert.equal(after.projects[0].workspaces.length, 1);
	});

	it("names a worktree created without a name", async () => {
		const { projects } = await api("GET", "/api/projects");
		const first = await api("POST", `/api/projects/${projects[0].id}/worktrees`, {});
		const second = await api("POST", `/api/projects/${projects[0].id}/worktrees`, {});
		assert.match(first.branch, /^[a-z]+-[a-z]+(-\d+)?$/);
		assert.notEqual(first.branch, second.branch);
		assert.ok(existsSync(join(first.path, "README.md")));
		for (const created of [first, second]) await api("DELETE", `/api/workspaces/${created.id}`);
	});
});

describe("default model", () => {
	it("comes from flowie's settings.json, also for agents created without one", async () => {
		const dir = join(root, "data-settings");
		const json = async (url: string) => (await fetch(url)).json();
		let other = await startDaemon({ dataDir: dir, agentDir, models, port: 0 });
		try {
			const project = await (
				await fetch(`${other.url}/api/projects`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: repo }),
				})
			).json();
			const id = project.workspaces[0].id;
			assert.equal((await json(`${other.url}/api/workspaces/${id}`)).agent.model, undefined);
			await other.close();
			writeFileSync(
				join(dir, "settings.json"),
				JSON.stringify({ defaultModel: { provider: "faux", modelId: "faux-1" }, defaultThinkingLevel: "high" }),
			);
			other = await startDaemon({ dataDir: dir, agentDir, models, port: 0 });
			const { agent } = await json(`${other.url}/api/workspaces/${id}`);
			assert.deepEqual(agent.model, { provider: "faux", modelId: "faux-1" });
			assert.equal(agent.thinkingLevel, "high");
		} finally {
			await other.close();
		}
	});
});

// biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely.
async function api(method: string, path: string, body?: unknown): Promise<any> {
	const response = await fetch(`${daemon.url}${path}`, {
		method,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	const json = await response.json();
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
	return json;
}

/** A request with chosen headers (fetch would not send a foreign Host). */
function raw(
	path: string,
	headers: Record<string, string>,
	method = "GET",
	body?: unknown,
): Promise<{ status: number }> {
	return new Promise((resolve, reject) => {
		const req = request(
			`${daemon.url}${path}`,
			{ method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } },
			(res) => {
				res.resume();
				res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
			},
		);
		req.on("error", reject);
		req.end(body === undefined ? undefined : JSON.stringify(body));
	});
}

type Client = {
	view: ConversationView | undefined;
	/** How many first values (`value` messages) arrived. */
	values: number;
	status: string | undefined;
	/** Every status the watched workspace went through. */
	statuses: string[];
	send(message: unknown): void;
	until(condition: () => boolean, timeoutMs?: number): Promise<void>;
	close(): void;
};

async function connect(): Promise<Client> {
	const ws = new WebSocket(`${daemon.url.replace("http", "ws")}/api/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const waiters = new Set<() => void>();
	const client: Client = {
		view: undefined,
		values: 0,
		status: undefined,
		statuses: [],
		send: (message) => ws.send(JSON.stringify(message)),
		until: (condition, timeoutMs = 10_000) =>
			new Promise((resolve, reject) => {
				if (condition()) return resolve();
				const timer = setTimeout(() => {
					waiters.delete(check);
					reject(new Error(`Timed out; view: ${JSON.stringify(client.view?.entries.map((e) => e.kind))}`));
				}, timeoutMs);
				const check = () => {
					if (!condition()) return;
					clearTimeout(timer);
					waiters.delete(check);
					resolve();
				};
				waiters.add(check);
			}),
		close: () => ws.close(),
	};
	ws.on("message", (data) => {
		const message = JSON.parse(data.toString()) as ServerMessage;
		if (message.type === "value") {
			client.view = message.value;
			client.values++;
		}
		if (message.type === "ops") client.view = applyImmutable(client.view, message.ops as Op[]);
		if (message.type === "status") {
			client.status = message.status.kind;
			client.statuses.push(message.status.kind);
		}
		if (message.type === "error") throw new Error(`daemon: ${message.message}`);
		for (const check of [...waiters]) check();
	});
	return client;
}

function lastAssistantText(view: ConversationView | undefined): string | undefined {
	const last = view?.entries.findLast((entry) => entry.kind === "pi.assistant");
	const content = last?.model?.[0]?.content;
	if (!Array.isArray(content)) return undefined;
	return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
