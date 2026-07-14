import { strict as assert } from "node:assert";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { checkComments } from "./runner.ts";

const input = {
	session_id: "test",
	tool_name: "write",
	transcript_path: "",
	cwd: "/tmp",
	hook_event_name: "PostToolUse",
	tool_input: { file_path: "/tmp/example.ts", content: "// redundant\nconst value = 1\n" },
};

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), "comment-checker-test-")); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

async function executable(name, body) {
	const path = join(dir, name);
	await writeFile(path, `#!/bin/sh\n${body}\n`);
	await chmod(path, 0o755);
	return path;
}

describe("comment checker runner", () => {
	it("returns warnings only for checker exit code 2", async () => {
		assert.equal(await checkComments(await executable("warn", "cat >/dev/null; echo unnecessary-comment >&2; exit 2"), input, 1000), "unnecessary-comment");
		assert.equal(await checkComments(await executable("pass", "cat >/dev/null; exit 0"), input, 1000), undefined);
		assert.equal(await checkComments(await executable("fail", "cat >/dev/null; echo broken >&2; exit 1"), input, 1000), undefined);
	});

	it("fails open when the checker times out", async () => {
		assert.equal(await checkComments(await executable("slow", "sleep 2"), input, 20), undefined);
	});
});
