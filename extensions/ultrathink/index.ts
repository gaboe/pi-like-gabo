import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandSkillReferences } from "../multi-skills/expansion";
import { buildSkillRegistry } from "../multi-skills/resolver";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("ultrathink", {
    description: "Run one task in explicit bounded maximum-depth multi-agent mode",
    handler: async (args, ctx) => {
      const task = args.trim();
      const request = task
        ? `Task:\n${task}`
        : "Task:\nInfer the current task from the conversation context and continue that task.";
      const expanded = expandSkillReferences(
        `$ultrathink\n\n${request}`,
        buildSkillRegistry(pi.getCommands()),
      );
      if (!expanded.text || expanded.loaded.length !== 1) {
        if (ctx.hasUI) ctx.ui.notify("Could not load the ultrathink skill.", "error");
        return;
      }

      pi.sendUserMessage(expanded.text, { deliverAs: "followUp" });
    },
  });
}
