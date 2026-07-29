import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { piBackend } from "./src/backends/pi.ts";
import type { BackendSpawnTask } from "./src/domain.ts";

function task(provider: string, id: string): BackendSpawnTask {
  const model = { provider, id };
  return {
    prompt: "test",
    title: "test",
    cwd: process.cwd(),
    parent: {
      parentCwd: process.cwd(),
      projectTrusted: true,
      inheritedModel: model,
      modelRegistry: {
        find: () => model,
        getAll: () => [model],
      } as never,
    },
  };
}

for (const [provider, id] of [
  ["anthropic", "claude-sonnet"],
  ["openai-codex", "gpt-5.6-other"],
] as const)
  test(`Pi runtime rejects resolved ${provider}/${id} before session spawn`, async () => {
    await assert.rejects(
      Effect.runPromise(Effect.scoped(piBackend.spawn(task(provider, id)))),
      /Unsupported Pi subagent model/,
    );
  });
