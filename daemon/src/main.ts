// Starts the daemon: `FLOWIE_PORT` (default 7878), `FLOWIE_DATA_DIR` (default ~/.flowie), `FLOWIE_ALLOWED_ORIGINS`
// (comma-separated, for the web UI's dev server), `FLOWIE_FAKE=1` (a fake model instead of real providers).
import { startDaemon } from "./daemon.ts";
import { createFakeModels, FAKE_DEFAULTS } from "./fake-models.ts";

const fake = process.env.FLOWIE_FAKE === "1";
const daemon = await startDaemon({
	port: Number(process.env.FLOWIE_PORT ?? 7878),
	allowedOrigins: (process.env.FLOWIE_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
	...(fake ? { models: createFakeModels(), defaults: FAKE_DEFAULTS } : {}),
});
console.log(`flowie daemon on ${daemon.url}${fake ? " (fake model)" : ""}`);

const stop = (signal: string) => {
	console.log(`flowie: ${signal}, stopping`);
	// A second signal while closing exits at once.
	process.once(signal, () => process.exit(1));
	void daemon.close().then(
		() => process.exit(0),
		(error: unknown) => {
			console.error("flowie: close failed:", error);
			process.exit(1);
		},
	);
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
