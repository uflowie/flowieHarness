// The WebSocket at `/api/ws`: live conversation views (the transcript window, the streaming answer, running tools,
// the inbox) as Durable watches, and every workspace's status. One socket carries any number of watches.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationWindow, EntryId } from "@earendil-works/pi-durable";
import { type WebSocket, WebSocketServer } from "ws";
import type { Access } from "./access.ts";
import { conversationOf } from "./api.ts";
import type { Projects } from "./projects.ts";
import { ClientMessage, type ServerMessage } from "./protocol.ts";
import { message, type WorkspaceHosts } from "./workspaces.ts";

export type SocketDeps = {
	readonly access: Access;
	readonly projects: Projects;
	readonly hosts: WorkspaceHosts;
};

/** A client's frames are small commands; images go over HTTP. */
const MAX_CLIENT_FRAME = 64 * 1024;

/** Serves the WebSocket on `server`; returns the closer. */
export function attachSocket(server: Server, deps: SocketDeps): () => Promise<void> {
	const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME });
	server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		const refusal = deps.access.refusal(request);
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		if (path !== "/api/ws" || refusal) {
			socket.end(`HTTP/1.1 ${refusal ? "403 Forbidden" : "404 Not Found"}\r\nConnection: close\r\n\r\n`);
			return;
		}
		sockets.handleUpgrade(request, socket, head, (ws) => serveClient(ws, deps));
	});
	return () =>
		new Promise((resolve) => {
			for (const client of sockets.clients) client.close(1001, "Daemon stopping");
			sockets.close(() => resolve());
		});
}

function serveClient(ws: WebSocket, { projects, hosts }: SocketDeps): void {
	/** Running watches by subscription name, each with its stop. */
	const watches = new Map<string, () => Promise<void>>();
	/**
	 * The latest request per subscription name. Setting a watch up awaits several times; an `unwatch` or a newer `watch`
	 * of the same name arriving meanwhile must win, or two watches would feed one subscription and the client would
	 * apply every streamed change twice.
	 */
	const wanted = new Map<string, object>();
	let closed = false;
	const send = (msg: ServerMessage) =>
		new Promise<void>((resolve, reject) => {
			if (ws.readyState !== ws.OPEN) return reject(new Error("Socket closed"));
			ws.send(JSON.stringify(msg), (error) => (error ? reject(error) : resolve()));
		});

	const unsubscribe = hosts.onStatus((workspace, status) => {
		void send({ type: "status", workspace, status }).catch(() => {});
	});
	void send({ type: "statuses", statuses: hosts.statuses() }).catch(() => {});

	const watch = async (msg: Extract<ClientMessage, { type: "watch" }>) => {
		const request = {};
		wanted.set(msg.sub, request);
		await watches.get(msg.sub)?.();
		const workspace = await projects.workspace(msg.workspace);
		if (workspace === undefined) throw new Error("Unknown workspace");
		const held = await hosts.hold(workspace.id, workspace.path);
		let handle: Awaited<ReturnType<Conversation["watch"]>> | undefined;
		try {
			const conversation = await conversationOf(held.workspace, msg.conversation);
			const window: ConversationWindow = {
				...(msg.from === undefined ? {} : { from: msg.from as EntryId }),
				...(msg.min === undefined ? {} : { min: msg.min }),
			};
			const watching = await conversation.watch(BACKGROUND_CONTEXT, window);
			handle = watching;
			const stop = async () => {
				if (watches.get(msg.sub) === stop) watches.delete(msg.sub);
				await watching.stop();
			};
			// Superseded or cancelled while being set up, or the socket closed meanwhile: nobody will stop it later.
			if (closed || wanted.get(msg.sub) !== request) {
				await watching.stop();
				held.release();
				return;
			}
			watches.set(msg.sub, stop);
			void watching.closed.then((end) => {
				held.release();
				if (watches.get(msg.sub) === stop) watches.delete(msg.sub);
				void send({ type: "end", sub: msg.sub, reason: end.kind }).catch(() => {});
			});
			await send({ type: "value", sub: msg.sub, value: watching.value });
			// Awaiting the send is the backpressure: commits made meanwhile arrive folded into the next call.
			watching.start(async (call) => {
				if (call.kind === "value") await send({ type: "ops", sub: msg.sub, ops: call.ops });
			});
		} catch (error) {
			await handle?.stop();
			held.release();
			throw error;
		}
	};

	ws.on("message", (data, isBinary) => {
		let parsed: unknown;
		try {
			parsed = isBinary ? undefined : JSON.parse(data.toString());
		} catch {
			// Reported below as invalid.
		}
		if (!ClientMessage.check(parsed)) {
			void send({ type: "error", message: "Invalid message" }).catch(() => {});
			return;
		}
		const msg = parsed;
		if (msg.type === "unwatch") wanted.delete(msg.sub);
		const done = msg.type === "watch" ? watch(msg) : (watches.get(msg.sub)?.() ?? Promise.resolve());
		done.catch((error: unknown) => {
			void send({ type: "error", sub: msg.sub, message: message(error) }).catch(() => {});
		});
	});
	ws.on("close", () => {
		closed = true;
		unsubscribe();
		for (const stop of [...watches.values()]) void stop();
	});
}
