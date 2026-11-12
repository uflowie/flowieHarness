// Who may talk to the daemon. It listens on loopback only; on top, the Host header stops DNS rebinding (a public name
// resolving to 127.0.0.1) and the Origin header stops other web pages in the user's browser from driving the agent.
import type { IncomingMessage } from "node:http";

export type Access = {
	/** Why `request` is refused, or undefined when it may proceed. */
	refusal(request: IncomingMessage): string | undefined;
};

/** Loopback hosts on `port`; origins of the daemon itself plus `extraOrigins` (a dev server of the web UI). */
export function loopbackAccess(port: () => number, extraOrigins: readonly string[]): Access {
	return {
		refusal(request) {
			const hosts = loopbackHosts(port());
			if (!hosts.includes(request.headers.host ?? "")) return "Unexpected Host header";
			const origin = request.headers.origin;
			// Browsers always send Origin on WebSocket upgrades and cross-origin writes; tools like curl send none.
			if (origin === undefined) return undefined;
			if (hosts.some((host) => origin === `http://${host}`) || extraOrigins.includes(origin)) return undefined;
			return "Origin not allowed";
		},
	};
}

function loopbackHosts(port: number): string[] {
	return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}
