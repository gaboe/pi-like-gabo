import assert from "node:assert/strict";
import test from "node:test";
import decisionGuidance, { DECISION_GUIDANCE } from "./index.ts";

test("adds adaptive decision support to every agent turn", () => {
	let handler;
	decisionGuidance({
		on(event, callback) {
			if (event === "before_agent_start") handler = callback;
		},
	});

	const result = handler({ systemPrompt: "base prompt" });
	assert.equal(result.systemPrompt, `base prompt\n\n${DECISION_GUIDANCE}`);
	assert.match(result.systemPrompt, /simple, low-risk, reversible choices/);
	assert.match(result.systemPrompt, /complex, ambiguous, high-impact/);
	assert.match(result.systemPrompt, /show the decision brief first/);
	assert.match(result.systemPrompt, /Never treat a recommendation as user approval/);
});
