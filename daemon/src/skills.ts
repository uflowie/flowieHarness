// Skills as pi's coding agent finds and lists them (pi/packages/coding-agent/src/core/skills.ts): the user's in
// `<agent dir>/skills`, the project's in `<cwd>/.pi/skills`. The prompt lists each skill's name, description and file;
// the model reads the file when a task matches. pi's warnings (invalid names, unparsable frontmatter) are not reported.
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { parse } from "yaml";

export type Skill = {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
	/** `disable-model-invocation: true`: pi only runs it by command, so the prompt leaves it out. */
	readonly disableModelInvocation: boolean;
};

/** The user's skills, then the project's; on a name collision the first one found wins, as in pi. */
export async function loadSkills(agentDir: string, cwd: string): Promise<Skill[]> {
	const byName = new Map<string, Skill>();
	const seen = new Set<string>();
	for (const dir of [join(agentDir, "skills"), resolve(cwd, ".pi", "skills")])
		for (const skill of await loadSkillsFromDir(dir, true, ignore(), dir)) {
			// The same file reached through a symbolic link loads once.
			const real = await realpath(skill.filePath).catch(() => skill.filePath);
			if (seen.has(real) || byName.has(skill.name)) continue;
			seen.add(real);
			byName.set(skill.name, skill);
		}
	return [...byName.values()];
}

/** pi's skills prompt for the model-invocable `skills`; undefined when there are none. */
export function formatSkillsForPrompt(skills: readonly Skill[]): string | undefined {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return undefined;
	return [
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
		"",
		"<available_skills>",
		...visible.flatMap((skill) => [
			"  <skill>",
			`    <name>${escapeXml(skill.name)}</name>`,
			`    <description>${escapeXml(skill.description)}</description>`,
			`    <location>${escapeXml(skill.filePath)}</location>`,
			"  </skill>",
		]),
		"</available_skills>",
	].join("\n");
}

/**
 * pi's discovery rules: a directory with a SKILL.md is a skill and is not searched further; otherwise the `.md` files
 * directly in the root are skills, and subdirectories are searched for SKILL.md. Dot entries, node_modules and what
 * `.gitignore`, `.ignore` or `.fdignore` files exclude are skipped.
 */
async function loadSkillsFromDir(dir: string, includeRootFiles: boolean, ig: Ignore, root: string): Promise<Skill[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
	if (entries === undefined) return [];
	await addIgnoreRules(ig, dir, root);

	const declared = entries.find((entry) => entry.name === "SKILL.md");
	if (declared) {
		const path = join(dir, declared.name);
		const kind = await kindOf(declared, path);
		if (kind === "file" && !ig.ignores(toPosix(relative(root, path)))) {
			const skill = await loadSkillFromFile(path);
			return skill ? [skill] : [];
		}
	}

	const skills: Skill[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		const kind = await kindOf(entry, path);
		const relativePath = toPosix(relative(root, path));
		if (ig.ignores(kind === "directory" ? `${relativePath}/` : relativePath)) continue;
		if (kind === "directory") skills.push(...(await loadSkillsFromDir(path, false, ig, root)));
		else if (kind === "file" && includeRootFiles && entry.name.endsWith(".md")) {
			const skill = await loadSkillFromFile(path);
			if (skill) skills.push(skill);
		}
	}
	return skills;
}

/** What `entry` is, following a symbolic link; a broken link is neither. */
async function kindOf(entry: Dirent, path: string): Promise<"file" | "directory" | undefined> {
	if (entry.isSymbolicLink()) {
		const target = await stat(path).catch(() => undefined);
		return target?.isFile() ? "file" : target?.isDirectory() ? "directory" : undefined;
	}
	return entry.isFile() ? "file" : entry.isDirectory() ? "directory" : undefined;
}

/** A skill needs a description; its name defaults to its directory's. */
async function loadSkillFromFile(filePath: string): Promise<Skill | undefined> {
	const content = await readFile(filePath, "utf8").catch(() => undefined);
	if (content === undefined) return undefined;
	const frontmatter = parseFrontmatter(content);
	if (frontmatter === undefined) return undefined;
	const { description, name } = frontmatter;
	if (typeof description !== "string" || description.trim() === "") return undefined;
	return {
		name: typeof name === "string" && name ? name : basename(dirname(filePath)),
		description,
		filePath,
		disableModelInvocation: frontmatter["disable-model-invocation"] === true,
	};
}

/** The YAML between leading `---` lines; empty without one, undefined when it does not parse. */
function parseFrontmatter(content: string): Record<string, unknown> | undefined {
	const text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
	if (!text.startsWith("---")) return {};
	const end = text.indexOf("\n---", 3);
	if (end === -1) return {};
	try {
		// Trust boundary: user-written YAML; only string and boolean fields are read from it.
		return (parse(text.slice(4, end)) ?? {}) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** Adds `dir`'s ignore files to `ig`, their patterns made relative to `root`. */
async function addIgnoreRules(ig: Ignore, dir: string, root: string): Promise<void> {
	const relativeDir = relative(root, dir);
	const prefix = relativeDir ? `${toPosix(relativeDir)}/` : "";
	for (const name of IGNORE_FILE_NAMES) {
		const content = await readFile(join(dir, name), "utf8").catch(() => undefined);
		if (content === undefined) continue;
		const patterns = content
			.split(/\r?\n/)
			.map((line) => prefixIgnorePattern(line, prefix))
			.filter((line) => line !== undefined);
		if (patterns.length > 0) ig.add(patterns);
	}
}

function prefixIgnorePattern(line: string, prefix: string): string | undefined {
	const trimmed = line.trim();
	if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return undefined;
	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) pattern = pattern.slice(1);
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	return `${negated ? "!" : ""}${prefix}${pattern}`;
}

function toPosix(path: string): string {
	return path.split(sep).join("/");
}

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
