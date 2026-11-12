// One pi-durable Harness per workspace (worktree), in this process: opened on first use, resumed so work a previous
// daemon left goes on, and closed once idle. Each has its own SQLite file, so workspaces never share a commit line.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	AgentDoc,
	type Conversation,
	type DocumentWatch,
	Harness,
	type HarnessSettings,
	LiveDoc,
	type LiveState,
	ROOT_CONVERSATION_ID,
	type RegistryReader,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { DataDir } from "./data-dir.ts";
import type { AgentDefaults } from "./models.ts";
import type { WorkspaceStatus } from "./protocol.ts";

export type { WorkspaceStatus };

/** An open workspace: its Harness and its one agent, the root conversation. */
export type OpenWorkspace = {
	readonly id: string;
	readonly path: string;
	readonly harness: Harness;
	readonly root: Conversation;
};

export type WorkspaceHostsOptions = {
	readonly dataDir: DataDir;
	readonly models: Models | (() => Models);
	readonly registry: RegistryReader;
	readonly defaults: () => AgentDefaults;
	readonly settings?: HarnessSettings;
	/** How long an unwatched workspace with no work stays open after its last use (default 10 minutes). */
	readonly idleMs?: number;
};

/** An open (or opening) workspace's bookkeeping; compared by identity, so a reopened workspace is a new one. */
type HostState = {
	readonly path: string;
	/** Watches holding it open. */
	holds: number;
	lastUsed: number;
	status: WorkspaceStatus;
	closing?: Promise<void>;
};

type Host = HostState & { readonly opened: Promise<OpenWorkspace> };

const SWEEP_MS = 60_000;

export class WorkspaceHosts {
	readonly #options: WorkspaceHostsOptions;
	readonly #hosts = new Map<string, Host>();
	/** Statuses of workspaces that are not open: why the last one closed or failed. */
	readonly #ended = new Map<string, WorkspaceStatus>();
	readonly #listeners = new Set<(id: string, status: WorkspaceStatus) => void>();
	readonly #sweep: NodeJS.Timeout;

	constructor(options: WorkspaceHostsOptions) {
		this.#options = options;
		this.#sweep = setInterval(() => void this.#closeIdle(), SWEEP_MS).unref();
	}

	/** The open workspace `id` at `path`, opening it first if needed. */
	async use(id: string, path: string): Promise<OpenWorkspace> {
		const host = this.#host(id, path);
		host.lastUsed = Date.now();
		return host.opened;
	}

	/** `use`, and keeps it open until `release` (for a client watching it). */
	async hold(id: string, path: string): Promise<{ readonly workspace: OpenWorkspace; release(): void }> {
		const host = this.#host(id, path);
		host.holds++;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			host.holds--;
			host.lastUsed = Date.now();
		};
		try {
			return { workspace: await host.opened, release };
		} catch (error) {
			release();
			throw error;
		}
	}

	status(id: string): WorkspaceStatus {
		return this.#hosts.get(id)?.status ?? this.#ended.get(id) ?? { kind: "closed" };
	}

	/** The status of every workspace that is open, or was in this daemon's lifetime. */
	statuses(): Record<string, WorkspaceStatus> {
		const all: Record<string, WorkspaceStatus> = Object.fromEntries(this.#ended);
		for (const [id, host] of this.#hosts) all[id] = host.status;
		return all;
	}

	/** Calls `listener` with every status change; returns the unsubscribe. */
	onStatus(listener: (id: string, status: WorkspaceStatus) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Opens every workspace with stored data whose directory still exists, so runs a previous daemon left unfinished go
	 * on. The idle sweep closes the ones with nothing to do.
	 */
	async resumeAll(): Promise<void> {
		const opening: Promise<unknown>[] = [];
		for (const id of readdirSync(this.#options.dataDir.workspacesDir)) {
			const path = readMeta(join(this.#options.dataDir.workspacesDir, id))?.path;
			if (path === undefined || !existsSync(path)) continue;
			opening.push(this.use(id, path).catch(() => {}));
		}
		await Promise.all(opening);
	}

	/** Closes workspace `id` if it is open; running work stays stored and resumes at the next open. */
	async close(id: string): Promise<void> {
		const host = this.#hosts.get(id);
		if (host === undefined) return;
		host.closing ??= host.opened.then(
			(open) => open.harness.close(BACKGROUND_CONTEXT),
			() => {},
		);
		await host.closing;
	}

	/** Closes workspace `id` and moves its data to the archive (for a removed worktree). */
	async archive(id: string): Promise<void> {
		await this.close(id);
		const dir = join(this.#options.dataDir.workspacesDir, id);
		if (existsSync(dir)) renameSync(dir, join(this.#options.dataDir.archiveDir, `${id}-${Date.now()}`));
		this.#ended.delete(id);
	}

	async closeAll(): Promise<void> {
		clearInterval(this.#sweep);
		await Promise.all([...this.#hosts.keys()].map((id) => this.close(id)));
	}

	#host(id: string, path: string): Host {
		const existing = this.#hosts.get(id);
		if (existing && existing.closing === undefined) return existing;
		const state: HostState = { path, holds: 0, lastUsed: Date.now(), status: { kind: "opening" } };
		this.#hosts.set(id, state as Host);
		// Storage takes one writer: a reopen waits for the previous Harness to finish closing.
		const host: Host = Object.assign(state, { opened: this.#open(id, path, state, existing?.closing) });
		this.#ended.delete(id);
		for (const listener of this.#listeners) listener(id, host.status);
		// A failed open is not kept: the next use tries again.
		host.opened.catch((error: unknown) => this.#end(id, host, { kind: "failed", error: message(error) }));
		return host;
	}

	async #open(id: string, path: string, host: HostState, after: Promise<void> | undefined): Promise<OpenWorkspace> {
		await after;
		const dir = join(this.#options.dataDir.workspacesDir, id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "meta.json"), `${JSON.stringify({ path })}\n`);
		const storage = await openNodeSqliteStorage(join(dir, "harness.sqlite"));
		// One environment per directory: `edit` and `write` serialize per environment, and close kills its processes.
		const envs = new Map<string, NodeExecutionEnv>();
		let harness: Harness;
		try {
			harness = await Harness.open(
				storage,
				{
					models: this.#options.models,
					registry: this.#options.registry,
					...(this.#options.settings === undefined ? {} : { settings: this.#options.settings }),
					env: ({ cwd = path }) => {
						let env = envs.get(cwd);
						if (env === undefined) envs.set(cwd, (env = new NodeExecutionEnv({ cwd })));
						return env;
					},
					onReport: (report) => console.error(`flowie: workspace ${id}: ${report.kind}:`, report.error),
				},
				BACKGROUND_CONTEXT,
			);
		} catch (error) {
			await storage.close(BACKGROUND_CONTEXT).catch(() => {});
			throw error;
		}
		let root: Conversation;
		let live: DocumentWatch<LiveState> | undefined;
		try {
			const defaults = this.#options.defaults();
			root = await harness.root(BACKGROUND_CONTEXT, { agent: { ...defaults, cwd: path } });
			await adoptDefaults(harness, root, defaults);
			live = await harness.watchDoc(LiveDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
		} catch (error) {
			// A retry opens the storage again: this Harness must not stay a second writer.
			await harness.close(BACKGROUND_CONTEXT).catch(() => {});
			throw error;
		}
		live?.start(async (call) => {
			if (call.kind === "value") this.#setStatus(id, host, liveStatus(call.value));
		});
		if (live) this.#setStatus(id, host, liveStatus(live.value));
		void harness.closed.then(async (end) => {
			await stopWatch(live);
			await Promise.all([...envs.values()].map((env) => env.cleanup(BACKGROUND_CONTEXT).catch(() => {})));
			this.#end(
				id,
				host,
				end.kind === "failed" ? { kind: "failed", error: message(end.error) } : { kind: "closed" },
			);
		});
		harness.resume();
		return { id, path, harness, root };
	}

	/** Closes workspaces nobody watches that have no running or sleeping work, after `idleMs` without use. */
	async #closeIdle(): Promise<void> {
		const idleMs = this.#options.idleMs ?? 10 * 60_000;
		const now = Date.now();
		for (const [id, host] of this.#hosts) {
			if (host.holds > 0 || host.closing || now - host.lastUsed < idleMs) continue;
			const open = await host.opened.catch(() => undefined);
			const wake = open?.harness.wake();
			if (wake === undefined || wake.active || wake.at !== undefined) continue;
			await this.close(id);
		}
	}

	#setStatus(id: string, host: HostState, status: WorkspaceStatus): void {
		if (this.#hosts.get(id) !== host || sameStatus(host.status, status)) return;
		host.status = status;
		for (const listener of this.#listeners) listener(id, status);
	}

	#end(id: string, host: HostState, status: WorkspaceStatus): void {
		if (this.#hosts.get(id) !== host) return;
		this.#hosts.delete(id);
		this.#ended.set(id, status);
		for (const listener of this.#listeners) listener(id, status);
	}
}

/**
 * Gives an agent created without a default (none was configured, or pi's named an unknown model) the defaults there
 * are now; choices stored for the agent stay.
 */
async function adoptDefaults(harness: Harness, root: Conversation, defaults: AgentDefaults): Promise<void> {
	const stored = await harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
	const change = {
		...(stored?.model === undefined && defaults.model ? { model: defaults.model } : {}),
		...(stored?.thinkingLevel === undefined && defaults.thinkingLevel ? { thinkingLevel: defaults.thinkingLevel } : {}),
	};
	if (Object.keys(change).length) await root.configure(change, BACKGROUND_CONTEXT);
}

function liveStatus(live: Readonly<LiveState>): WorkspaceStatus {
	if (live.run !== undefined) return { kind: "busy" };
	return live.runFailure === undefined ? { kind: "idle" } : { kind: "idle", runFailure: live.runFailure.reason };
}

function sameStatus(a: WorkspaceStatus, b: WorkspaceStatus): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

async function stopWatch(watch: DocumentWatch<LiveState> | undefined): Promise<void> {
	await watch?.stop().catch(() => {});
}

function readMeta(dir: string): { readonly path: string } | undefined {
	try {
		const meta: unknown = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
		// Trust boundary: a file on disk.
		return typeof (meta as { path?: unknown })?.path === "string" ? (meta as { path: string }) : undefined;
	} catch {
		return undefined;
	}
}

export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
