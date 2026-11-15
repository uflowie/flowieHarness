// Skill discovery and the skills prompt, following pi's coding agent: where skills are found, what makes one, and
// which the prompt lists.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { formatSkillsForPrompt, loadSkills, type Skill } from "../src/skills.ts";

const root = mkdtempSync(join(tmpdir(), "flowie-skills-"));
const agentDir = join(root, "agent");
const cwd = join(root, "repo");
const userSkills = join(agentDir, "skills");
const projectSkills = join(cwd, ".pi", "skills");

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

const skill = (fields: string) => `---\n${fields}\n---\n\nBody.\n`;

let skills: Skill[];

before(async () => {
	write(join(userSkills, "deploy", "SKILL.md"), skill("description: Deploys the app"));
	// A directory with SKILL.md is not searched further.
	write(join(userSkills, "deploy", "nested", "SKILL.md"), skill("name: nested\ndescription: Hidden"));
	write(join(userSkills, "root-file.md"), skill("name: root-file\ndescription: A loose file in the root"));
	write(join(userSkills, "notes.md"), "# No frontmatter, so not a skill\n");
	// Loose .md files count only in the root.
	write(join(userSkills, "group", "loose.md"), skill("name: loose\ndescription: Not in the root"));
	write(join(userSkills, "group", "review", "SKILL.md"), skill("name: review\ndescription: User review"));
	write(join(userSkills, "undescribed", "SKILL.md"), skill("name: undescribed"));
	write(join(userSkills, "manual", "SKILL.md"), skill("description: Only by command\ndisable-model-invocation: true"));
	write(join(userSkills, "node_modules", "dep", "SKILL.md"), skill("name: dep\ndescription: A dependency"));
	write(join(userSkills, ".hidden", "SKILL.md"), skill("name: hidden\ndescription: A dot directory"));
	write(join(userSkills, ".gitignore"), "ignored/\n");
	write(join(userSkills, "ignored", "SKILL.md"), skill("name: ignored\ndescription: Git-ignored"));
	write(join(projectSkills, "review", "SKILL.md"), skill("name: review\ndescription: Project review"));
	write(join(projectSkills, "lint", "SKILL.md"), skill("description: \"Lints <src> & tests\""));
	skills = await loadSkills(agentDir, cwd);
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("loadSkills", () => {
	it("finds user and project skills by pi's discovery rules", () => {
		assert.deepEqual(skills.map((each) => each.name).sort(), ["deploy", "lint", "manual", "review", "root-file"]);
	});

	it("names a skill after its directory when the frontmatter has no name", () => {
		const deploy = skills.find((each) => each.name === "deploy");
		assert.equal(deploy?.filePath, join(userSkills, "deploy", "SKILL.md"));
	});

	it("keeps the user's skill on a name collision", () => {
		assert.equal(skills.find((each) => each.name === "review")?.description, "User review");
	});

	it("finds nothing when neither directory exists", async () => {
		assert.deepEqual(await loadSkills(join(root, "none"), join(root, "none")), []);
	});
});

describe("formatSkillsForPrompt", () => {
	it("lists model-invocable skills with escaped text", () => {
		const prompt = formatSkillsForPrompt(skills);
		assert.ok(prompt?.includes("<name>lint</name>"));
		assert.ok(prompt?.includes("<description>Lints &lt;src&gt; &amp; tests</description>"));
		assert.ok(prompt?.includes(`<location>${join(projectSkills, "lint", "SKILL.md")}</location>`));
		assert.ok(!prompt?.includes("manual"), "disable-model-invocation leaves a skill out");
	});

	it("is absent without skills", () => {
		assert.equal(formatSkillsForPrompt([]), undefined);
	});
});
