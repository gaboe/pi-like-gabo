import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBoundedAuditRecorder, observeToolCall } from "./policy.ts";

export default function permissions(pi: ExtensionAPI): void {
  const audit = createBoundedAuditRecorder((event) => {
    try {
      pi.events.emit("permissions:audit", event);
    } catch {}
  });

  pi.on("session_start", () => audit.reset());
  pi.on("tool_call", (event, ctx) => {
    observeToolCall(event, ctx.cwd, audit.record);
    return undefined;
  });
}
