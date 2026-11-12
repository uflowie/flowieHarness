// The flowie extension's provider request hook: detailed reasoning summaries for OpenAI Responses models.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detailedReasoningSummaries } from "../src/agent.ts";

describe("detailedReasoningSummaries", () => {
	it("asks OpenAI Responses models for detailed summaries", () => {
		const payload = { model: "gpt-6.1-sol", reasoning: { effort: "high", summary: "auto" } };
		assert.deepEqual(detailedReasoningSummaries({ model: { api: "openai-responses" }, payload }), {
			payload: { model: "gpt-6.1-sol", reasoning: { effort: "high", summary: "detailed" } },
		});
		assert.equal(payload.reasoning.summary, "auto", "the original body is not changed");
	});

	it("leaves other APIs, requests without reasoning and explicit choices alone", () => {
		const auto = { reasoning: { effort: "high", summary: "auto" } };
		assert.equal(detailedReasoningSummaries({ model: { api: "anthropic-messages" }, payload: auto }), undefined);
		assert.equal(detailedReasoningSummaries({ model: { api: "openai-responses" }, payload: { reasoning: { effort: "none" } } }), undefined);
		const concise = { reasoning: { effort: "high", summary: "concise" } };
		assert.equal(detailedReasoningSummaries({ model: { api: "openai-responses" }, payload: concise }), undefined);
	});
});
