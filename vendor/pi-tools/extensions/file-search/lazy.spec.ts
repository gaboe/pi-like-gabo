import assert from "node:assert/strict";
import { it, vi } from "vitest";

vi.mock("./src/runtime.ts", () => {
  throw new Error("runtime loaded");
});

it("registration defers runtime loading until a tool is invoked", async () => {
  const { default: fileSearchTools } = await import("./index.ts");
  const tools: {
    name: string;
    execute: (...args: unknown[]) => Promise<unknown>;
  }[] = [];
  fileSearchTools({
    registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
  } as never);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["fd", "rg"],
  );
  await assert.rejects(
    () =>
      tools[0].execute("id", {}, undefined, undefined, {
        cwd: process.cwd(),
        hasUI: false,
      }),
    (error) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      error.cause.message === "runtime loaded",
  );
});
