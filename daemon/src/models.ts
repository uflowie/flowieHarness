// Model access: pi-ai's built-in providers with pi's credentials, and the default model pi's settings name.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models, MutableModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import type { ModelRef } from "@earendil-works/pi-durable";
import { compile } from "@earendil-works/pi-schema";
import { FileCredentialStore } from "./credentials.ts";

/** What a new workspace's agent starts with. */
export type AgentDefaults = {
	readonly model?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
};

/** pi's agent directory: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export function piAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** The built-in providers, authenticated by environment variables and pi's `auth.json`. */
export function createModels(agentDir: string): MutableModels {
	return builtinModels({ credentials: new FileCredentialStore(join(agentDir, "auth.json")) });
}

const isThinkingLevel = compile(ModelThinkingLevelSchema).check;

/**
 * What new agents start with: flowie's `settings.json` (`defaultModel`, `defaultThinkingLevel`) over the defaults pi's
 * `settings.json` names, without a model `models` does not know: pi's CLI may be older or newer than this daemon's
 * catalog, and an unknown model would fail every run. Read at each use, so an edit applies to the next agent. Warns once
 * per unknown model.
 */
export function knownAgentDefaults(agentDir: string, settingsFile: string, models: Models): AgentDefaults {
	const { model, ...rest } = { ...readAgentDefaults(agentDir), ...readFlowieDefaults(settingsFile) };
	if (model === undefined || models.getModel(model.provider, model.modelId)) return model ? { model, ...rest } : rest;
	const key = `${model.provider}/${model.modelId}`;
	if (!warned.has(key)) {
		warned.add(key);
		console.warn(`flowie: pi's default model ${key} is not in this catalog; pick a model per workspace`);
	}
	return rest;
}

const warned = new Set<string>();

/** The default model and thinking level from flowie's `settings.json`; empty when it names none or is invalid. */
function readFlowieDefaults(settingsFile: string): AgentDefaults {
	let settings: { defaultModel?: unknown; defaultThinkingLevel?: unknown };
	try {
		settings = JSON.parse(readFileSync(settingsFile, "utf8"));
	} catch {
		return {};
	}
	// Trust boundary: a file the user edits.
	const model = settings.defaultModel as { provider?: unknown; modelId?: unknown } | undefined;
	const level = settings.defaultThinkingLevel;
	return {
		...(typeof model?.provider === "string" && typeof model.modelId === "string"
			? { model: { provider: model.provider, modelId: model.modelId } }
			: {}),
		...(isThinkingLevel(level) ? { thinkingLevel: level } : {}),
	};
}

/** The default model and thinking level from pi's `settings.json`; empty when it names none. */
function readAgentDefaults(agentDir: string): AgentDefaults {
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	} catch {
		return {};
	}
	const { defaultProvider: provider, defaultModel: modelId, defaultThinkingLevel: level } = settings;
	return {
		...(typeof provider === "string" && typeof modelId === "string" ? { model: { provider, modelId } } : {}),
		...(isThinkingLevel(level) ? { thinkingLevel: level } : {}),
	};
}
