import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isLegacyTaskDetails } from "./replay.ts";
import { detectCycle } from "./task-graph.ts";

const task = (id, blockedBy = []) => ({ id, subject: `Task ${id}`, status: "pending", blockedBy });

describe("todo state hardening", () => {
	it("rejects corrupt replay snapshots", () => {
		assert.equal(isLegacyTaskDetails({ tasks: [task(1, [2])], nextId: 2 }), false);
		assert.equal(isLegacyTaskDetails({ tasks: [task(1), task(1)], nextId: 2 }), false);
		assert.equal(isLegacyTaskDetails({ tasks: [task(1)], nextId: 2 }), true);
	});

	it("detects deep cycles without recursion", () => {
		const tasks = Array.from({ length: 10_000 }, (_, index) => task(index + 1, index ? [index] : []));
		assert.equal(detectCycle(tasks, 1, [10_000]), true);
		assert.equal(detectCycle(tasks, -1, []), false);
	});
});
