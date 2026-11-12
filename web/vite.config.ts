import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const daemon = `http://127.0.0.1:${process.env.FLOWIE_PORT ?? 7878}`;

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			// pi-durable's transcript merger is browser-safe but not exported on its own; the package root pulls in the
			// whole Harness. Pinned to the exact installed version, so a pi-durable upgrade is checked here.
			"pi-durable-transcript": fileURLToPath(
				new URL("../node_modules/@earendil-works/pi-durable/dist/harness/transcript.js", import.meta.url),
			),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		proxy: { "/api": { target: daemon, ws: true, changeOrigin: true } },
	},
});
