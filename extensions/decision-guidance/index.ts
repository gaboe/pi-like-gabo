import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DECISION_GUIDANCE = `For code or review decisions with relevant code, default to an evidence-rich prose packet, not a generic minimalist option prompt. Use this exact order:
1. Source/link.
2. Full verbatim user request or review comment.
3. Current code snippet, labeled file:line, with sufficient surrounding lines for context.
4. Supporting evidence.
5. Recommendation.
6. Draft reply.

Write prose by default. Present options only when user explicitly asks for options. If evidence is missing, label it unavailable; never fabricate evidence, sources, comments, or code. For decisions with no relevant code, omit this packet and keep simple decisions concise.

Never treat a recommendation as user approval.

Before emitting tool_batch, normalize nested tool names: use grep instead of rg and find instead of fd. The only valid nested names are read, grep, find, ls, and bash. Keep standalone content search on rg and standalone file discovery on fd; this rule applies only inside tool_batch.`;

export default function decisionGuidance(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${DECISION_GUIDANCE}`,
  }));
}
