import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { providerErrorMetadataFromMessages } from "./runner.ts";
import { classifyRetry, pausedProviderMetadata } from "./retry.ts";

test("runner metadata reaches production retry classifier without raw provider data", () => {
  const message = {
    role: "assistant",
    provider: "openai",
    model: "fixture",
    api: "responses",
    content: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "secret raw message",
    timestamp: 1,
    diagnostics: [
      {
        type: "pi_messages_response_failure",
        message: "secret diagnostic",
        details: {
          status: 429,
          error: { code: "quota_exceeded", type: "rate_limit" },
          retryAfter: 12,
          secret: "never persist",
        },
      },
    ],
  } as unknown as AssistantMessage;
  const metadata = providerErrorMetadataFromMessages([message]);
  assert.deepEqual(metadata, {
    status: 429,
    code: "quota_exceeded",
    provider: "openai",
    errorType: "rate_limit",
    retryAfter: 12,
  });
  assert.deepEqual(classifyRetry(message.errorMessage, metadata), {
    category: "quota",
    retryable: false,
    retryAfter: 12,
  });
  assert.doesNotMatch(JSON.stringify(metadata), /secret/);
  assert.equal(
    classifyRetry(new Error("429 quota exceeded retry after 60 seconds"))
      .category,
    "unknown",
  );
});

test("paused metadata is bounded structured data", () => {
  const paused = pausedProviderMetadata({
    provider: "provider\u0000" + "x".repeat(200),
    code: "quota_exceeded",
  });
  assert.equal(paused.provider?.length, 128);
  assert.equal(paused.reason, "Provider quota (quota_exceeded)");
  assert.doesNotMatch(JSON.stringify(paused), /[\u0000-\u001f\u007f]/);
});
