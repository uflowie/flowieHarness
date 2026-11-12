// The one WebSocket to the daemon: workspace statuses, and conversation watches that survive reconnects.
import type { Op } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { ServerMessage, WorkspaceStatus } from "@flowie/daemon/protocol";

export type WatchParams = { readonly workspace: string; readonly conversation?: number; readonly from?: number };

export type WatchHandlers = {
	value(view: ConversationView): void;
	ops(ops: readonly Op[]): void;
	end(reason: string): void;
	error(message: string): void;
};

type Watch = { readonly params: () => WatchParams; readonly handlers: WatchHandlers };

const MAX_BACKOFF_MS = 5_000;

class DaemonSocket {
	#ws: WebSocket | undefined;
	#backoff = 250;
	readonly #watches = new Map<string, Watch>();
	#statuses: Readonly<Record<string, WorkspaceStatus>> = {};
	#connected = false;
	readonly #listeners = new Set<() => void>();

	/** Statuses of the workspaces the daemon knows to be open, or to have closed or failed. */
	get statuses(): Readonly<Record<string, WorkspaceStatus>> {
		return this.#statuses;
	}

	get connected(): boolean {
		return this.#connected;
	}

	/** For `useSyncExternalStore`: called on status and connection changes. */
	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		this.#connect();
		return () => this.#listeners.delete(listener);
	};

	/**
	 * Follows a conversation until the returned stop. `params` is read at every (re)connect, so a reconnect resumes
	 * after the newest entry the caller has.
	 */
	watch(sub: string, params: () => WatchParams, handlers: WatchHandlers): () => void {
		const watch = { params, handlers };
		this.#watches.set(sub, watch);
		this.#connect();
		this.#sendWatch(sub, watch);
		return () => {
			if (this.#watches.get(sub) !== watch) return;
			this.#watches.delete(sub);
			this.#send({ type: "unwatch", sub });
		};
	}

	#connect(): void {
		if (this.#ws) return;
		const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
		this.#ws = ws;
		ws.onopen = () => {
			this.#backoff = 250;
			this.#setConnected(true);
			for (const [sub, watch] of this.#watches) this.#sendWatch(sub, watch);
		};
		ws.onmessage = (event) => this.#receive(JSON.parse(String(event.data)) as ServerMessage);
		ws.onclose = () => {
			this.#ws = undefined;
			this.#setConnected(false);
			setTimeout(() => this.#connect(), this.#backoff);
			this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS);
		};
	}

	#receive(message: ServerMessage): void {
		switch (message.type) {
			case "statuses":
				this.#statuses = message.statuses;
				return this.#notify();
			case "status":
				this.#statuses = { ...this.#statuses, [message.workspace]: message.status };
				return this.#notify();
			case "value":
				return this.#watches.get(message.sub)?.handlers.value(message.value);
			case "ops":
				return this.#watches.get(message.sub)?.handlers.ops(message.ops);
			case "end":
				return this.#watches.get(message.sub)?.handlers.end(message.reason);
			case "error":
				if (message.sub !== undefined) return this.#watches.get(message.sub)?.handlers.error(message.message);
				console.error("daemon:", message.message);
		}
	}

	#sendWatch(sub: string, watch: Watch): void {
		this.#send({ type: "watch", sub, ...watch.params() });
	}

	#send(message: unknown): void {
		if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
	}

	#setConnected(connected: boolean): void {
		this.#connected = connected;
		this.#notify();
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}

export const daemon = new DaemonSocket();
