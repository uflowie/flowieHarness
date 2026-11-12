// Development: the daemon on 7878, restarted on changes (`node --watch`; agents resume from storage), and Vite on 5173
// (proxying /api to the daemon), stopped together.
import { spawn } from "node:child_process";

const origins = "http://127.0.0.1:5173,http://localhost:5173";
const children = [
	spawn("npm", ["run", "dev", "-w", "daemon"], {
		stdio: "inherit",
		shell: true,
		env: { ...process.env, FLOWIE_ALLOWED_ORIGINS: origins },
	}),
	spawn("npm", ["run", "dev", "-w", "web"], { stdio: "inherit", shell: true }),
];
const stop = () => {
	for (const child of children) child.kill("SIGINT");
};
for (const child of children) child.on("exit", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
