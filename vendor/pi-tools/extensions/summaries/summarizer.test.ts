import assert from "node:assert/strict";
import test from "node:test";
import { parseRecapResponse, reasoningOptions } from "./src/summarizer.ts";
import { throwIfAborted, withAbortTimeout } from "./src/abort.ts";

test("cancellation forwards one reason and cleanup prevents later timeout", async () => {
  const controller = new AbortController();
  const operation = withAbortTimeout(controller.signal, 20);
  const reason = new Error("shutdown");
  controller.abort(reason);
  assert.equal(operation.signal.reason, reason);
  assert.throws(
    () => throwIfAborted(operation.signal),
    (error) => error === reason,
  );
  operation.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(operation.signal.reason, reason);
});

test("omits reasoning when configured off", () => {
  assert.deepEqual(reasoningOptions("off"), {});
  assert.deepEqual(reasoningOptions("medium"), { reasoning: "medium" });
});

test("parses strict recap JSON", () => {
  assert.deepEqual(
    parseRecapResponse(
      '{"recap":"Updated config and ran focused tests.","next":"Review the diff."}',
    ),
    {
      recap: "Updated config and ran focused tests.",
      next: "Review the diff.",
    },
  );
});

test("defensively extracts fenced or surrounded JSON and normalizes Next", () => {
  assert.deepEqual(
    parseRecapResponse(
      'Result follows:\n```json\n{"recap":"- Added the extension\\n- Tests pass","next":"Next: Reload Pi."}\n```',
    ),
    {
      recap: "- Added the extension\n- Tests pass",
      next: "Reload Pi.",
    },
  );
});

test("rejects malformed or incomplete output", () => {
  assert.throws(() => parseRecapResponse("not json"), /valid recap JSON/);
  assert.throws(
    () => parseRecapResponse('{"recap":"missing next"}'),
    /valid recap JSON/,
  );
  assert.throws(
    () =>
      parseRecapResponse(
        '{"recap":"done","next":"nothing","extra":"not allowed"}',
      ),
    /valid recap JSON/,
  );
});

test("strips terminal control sequences from recap fields", () => {
  assert.deepEqual(
    parseRecapResponse(
      '{"recap":"Updated \\u001b[31mconfig\\u001b[0m.","next":"Review it.\\u0007"}',
    ),
    { recap: "Updated config.", next: "Review it." },
  );
});
