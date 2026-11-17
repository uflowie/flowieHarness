// The daemon: one process on loopback that hosts every workspace's agent and serves the API and WebSocket.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { Models } from "@earendil-works/pi-ai/models";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { loopbackAccess } from "./access.ts";
import { createAgentRegistry } from "./agent.ts";
import { createApi } from "./api.ts";
import { defaultDataDir, openDataDir, takeProcessLock } from "./data-dir.ts";
import { type AgentDefaults, createModels, knownAgentDefaults, piAgentDir } from "./models.ts";
import { Projects } from "./projects.ts";
import { attachSocket } from "./socket.ts";
import { serveStatic } from "./static.ts";
import { WorkspaceHosts } from "./workspaces.ts";

export type DaemonOptions = {
	/** Default `FLOWIE_DATA_DIR`, else `~/.flowie`. */
	readonly dataDir?: string;
	/** Port on 127.0.0.1; 0 picks a free one. */
	readonly port?: number;
	/** pi's agent directory, for credentials, default model and global AGENTS.md (default `~/.pi/agent`). */
	readonly agentDir?: string;
	/** Model access instead of pi-ai's built-in providers (tests: the faux provider). */
	readonly models?: Models;
	/** A new workspace's model instead of flowie's and pi's settings. */
	readonly defaults?: AgentDefaults;
	/** Browser origins allowed besides the daemon's own, such as the web UI's dev server. */
	readonly allowedOrigins?: readonly string[];
	/** How long an unused, unwatched workspace with no work stays open. */
	readonly idleMs?: number;
	/** The built web UI (default: this repository's `web/dist`). */
	readonly webDir?: string;
};

/** VM memory per code mode script, as pi's coding agent allows. */
const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

const WEB_DIR =fileURLToPath(new URL("../../web/dist", import.meta.url));

export type Daemon = {
	readonly port: number;
	readonly url: string;
	close(): Promise<void>;
};

export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
	const dataDir = openDataDir(options.dataDir ?? defaultDataDir());
	const unlock = takeProcessLock(dataDir.root);
	try {
		const agentDir = options.agentDir ?? piAgentDir();
		const models = options.models ?? createModels(agentDir);
		const defaults = () => options.defaults ?? knownAgentDefaults(agentDir, dataDir.settingsFile, models);
		const projects = new Projects(dataDir);
		// Runs code mode scripts in worker threads. Closing it mid-script is safe: Durable resumes the script next start.
		const sandbox = new CodemodeSandbox({ memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES });
		const hosts = new WorkspaceHosts({
			dataDir,
			models,
			registry: createAgentRegistry(agentDir, sandbox),
			defaults,
			...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
		});
		let port = options.port ?? 0;
		const access = loopbackAccess(() => port, options.allowedOrigins ?? []);
		const api = createApi({ access, projects, hosts, models: () => models, defaults, agentDir });
		const web = serveStatic(options.webDir ?? WEB_DIR, access);
		const server = createServer((request, response) =>
			(request.url ?? "/").startsWith("/api/") ? api(request, response) : web(request, response),
		);
		const closeSocket = attachSocket(server, { access, projects, hosts });
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => resolve());
		});
		port = (server.address() as AddressInfo).port;
		// Runs a previous daemon left unfinished continue in the background.
		void hosts.resumeAll().catch((error: unknown) => console.error("flowie: resuming workspaces:", error));

		let closing: Promise<void> | undefined;
		return {
			port,
			url: `http://127.0.0.1:${port}`,
			close: () =>
				(closing ??= (async () => {
					await closeSocket();
					server.closeAllConnections();
					await new Promise<void>((resolve) => server.close(() => resolve()));
					await hosts.closeAll();
					await sandbox.close();
					unlock();
				})()),
		};
	} catch (error) {
		unlock();
		throw error;
	}
}
