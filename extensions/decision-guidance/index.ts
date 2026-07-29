import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DECISION_GUIDANCE = `Adapt explanation depth to the decision, not to a fixed response length.

For simple, low-risk, reversible choices, be concise: state the recommendation, the decisive reason, and any material caveat.

For complex, ambiguous, high-impact, costly, or hard-to-reverse choices, give the user enough relevant context to decide precisely before asking for a choice. Present a decision brief covering:
- the problem and why the decision is needed now;
- current state, constraints, assumptions, and important unknowns;
- viable options and how each solves the problem;
- material trade-offs, risks, reversibility, and evidence;
- your recommendation and why it best fits the stated constraints.

Scale each section to its relevance; do not bury the decision in unrelated implementation detail. When ask_user is available, show the decision brief first, then ask one focused question with clearly differentiated options. Never treat a recommendation as user approval.`;

export default function decisionGuidance(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${DECISION_GUIDANCE}`,
	}));
}
