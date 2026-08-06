import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRunEntries } from "./dashboard.ts";

function writeRun(directory: string, runId: string, workflow: object) {
  const runDir = join(directory, runId);
  writeFileSync(join(runDir, "workflow.json"), JSON.stringify(workflow), {
    encoding: "utf8",
    flag: "w",
  });
}

test("historical dashboard run IDs and entries stay cached across live refreshes", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-dashboard-"));
  try {
    const runId = "wf_history";
    const runDir = join(directory, runId);
    mkdirSync(runDir);
    writeRun(directory, runId, {
      sessionId: "session",
      status: "completed",
      startedAt: 1,
      phases: [],
      agents: [],
    });
    const historical = new Map();
    const knownRunIds = [runId];
    const first = loadRunEntries(
      new Map(),
      "session",
      new Set(),
      historical,
      directory,
      knownRunIds,
    );
    rmSync(directory, { recursive: true, force: true });
    const second = loadRunEntries(
      new Map(),
      "session",
      new Set(),
      historical,
      directory,
      knownRunIds,
    );

    assert.equal(first[0]?.runId, runId);
    assert.equal(second[0]?.details.status, "completed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("paused dashboard artifact round-trips and accepts prior artifact shape", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-dashboard-"));
  try {
    const runId = "wf_paused";
    mkdirSync(join(directory, runId));
    writeRun(directory, runId, {
      sessionId: "session",
      status: "paused",
      paused: { provider: "openai", reason: "Provider quota (rate_limit)" },
      startedAt: 1,
      phases: [],
      agents: [{ index: 1, label: "agent", state: "error", startedAt: 1 }],
    });
    const entry = loadRunEntries(
      new Map(),
      "session",
      new Set(),
      new Map(),
      directory,
    )[0]?.details;
    assert.equal(entry?.status, "paused");
    assert.deepEqual(entry?.paused, {
      provider: "openai",
      reason: "Provider quota (rate_limit)",
    });
    assert.equal(entry?.agents[0]?.attempts, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider error survives an artifact round-trip and is bounded", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-dashboard-"));
  try {
    const runId = "wf_provider_error";
    mkdirSync(join(directory, runId));
    writeRun(directory, runId, {
      sessionId: "session",
      status: "completed",
      startedAt: 1,
      phases: [],
      agents: [
        {
          index: 1,
          label: "agent",
          state: "error",
          startedAt: 1,
          providerError: {
            status: 429,
            code: "rate_limit_exceeded",
            provider: "openai",
            errorType: "RateLimitError",
            retryAfter: 30,
            resetAt: 1_700_000_000_000,
          },
        },
      ],
    });
    const entry = loadRunEntries(
      new Map(),
      "session",
      new Set(),
      new Map(),
      directory,
    )[0]?.details;
    assert.deepEqual(entry?.agents[0]?.providerError, {
      status: 429,
      code: "rate_limit_exceeded",
      provider: "openai",
      errorType: "RateLimitError",
      retryAfter: 30,
      resetAt: 1_700_000_000_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider error drops out-of-range and untyped fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-dashboard-"));
  try {
    const runId = "wf_provider_error_bounds";
    mkdirSync(join(directory, runId));
    writeRun(directory, runId, {
      sessionId: "session",
      status: "completed",
      startedAt: 1,
      phases: [],
      agents: [
        {
          index: 1,
          label: "bad-status",
          state: "error",
          startedAt: 1,
          providerError: {
            status: 99,
            retryAfter: -1,
            resetAt: 0,
            code: "   ",
          },
        },
        {
          index: 2,
          label: "not-an-object",
          state: "error",
          startedAt: 1,
          providerError: "boom",
        },
        {
          index: 3,
          label: "overlong",
          state: "error",
          startedAt: 1,
          providerError: { code: "c".repeat(200) },
        },
      ],
    });
    const agents = loadRunEntries(
      new Map(),
      "session",
      new Set(),
      new Map(),
      directory,
    )[0]?.details.agents;
    assert.equal(agents?.[0]?.providerError, undefined);
    assert.equal(agents?.[1]?.providerError, undefined);
    assert.equal(agents?.[2]?.providerError?.code?.length, 64);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("former live run reads once and recovers stale state", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-dashboard-"));
  try {
    const runId = "wf_stale";
    const runDir = join(directory, runId);
    mkdirSync(runDir);
    writeRun(directory, runId, {
      sessionId: "session",
      status: "running",
      startedAt: 1,
      phases: [],
      agents: [{ index: 1, label: "agent", state: "running", startedAt: 1 }],
    });
    const live = {
      runId,
      background: false,
      status: "running" as const,
      startedAt: 1,
      phases: [],
      agents: [],
    };
    const historical = new Map();
    assert.equal(
      loadRunEntries(
        new Map([[runId, live]]),
        "session",
        new Set(),
        historical,
        directory,
      )[0]?.live,
      true,
    );
    const recovered = loadRunEntries(
      new Map(),
      "session",
      new Set(),
      historical,
      directory,
    )[0];

    assert.equal(recovered?.details.status, "aborted");
    assert.equal(recovered?.details.agents[0]?.state, "error");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
