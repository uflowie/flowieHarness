// The global instruction file in pi's agent directory (`~/.pi/agent/AGENTS.md`), which every workspace's prompt
// includes and the web UI edits.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { INSTRUCTION_FILES } from "./agent.ts";
import type { GlobalInstructions } from "./protocol.ts";

/** The file the prompt reads (the first instruction file present), or a new AGENTS.md when there is none. */
export async function readGlobalInstructions(agentDir: string): Promise<GlobalInstructions> {
	for (const name of INSTRUCTION_FILES) {
		const path = join(agentDir, name);
		const found = await stat(path).catch(() => undefined);
		if (found?.isFile()) return { path, exists: true, content: await readFile(path, "utf8") };
	}
	return { path: join(agentDir, "AGENTS.md"), exists: false, content: "" };
}

/** Writes `content` to the file `readGlobalInstructions` names; the next request of every agent sees it. */
export async function writeGlobalInstructions(agentDir: string, content: string): Promise<GlobalInstructions> {
	const { path } = await readGlobalInstructions(agentDir);
	await mkdir(agentDir, { recursive: true });
	await writeFile(path, content, "utf8");
	return { path, exists: true, content };
}
