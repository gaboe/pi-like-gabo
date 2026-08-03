import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandSkillReferences } from "../multi-skills/expansion";
import { buildSkillRegistry } from "../multi-skills/resolver";

const SKILL_MD_PATH = fileURLToPath(new URL("../../skills/ultrathink/SKILL.md", import.meta.url));

export default function (pi: ExtensionAPI) {
  pi.registerCommand("ultrathink", {
    description: "Run one task in explicit bounded maximum-depth multi-agent mode",
    handler: async (args, ctx) => {
      const task = args.trim();
      const request = task
        ? `Task:\n${task}`
        : "Task:\nInfer the current task from the conversation context and continue that task.";
      const registry = buildSkillRegistry(pi.getCommands());
      if (!registry.has("ultrathink")) {
        registry.set("ultrathink", {
          name: "ultrathink",
          description: "Run one task in explicit bounded maximum-depth multi-agent mode",
          dir: dirname(SKILL_MD_PATH),
          skillMdPath: SKILL_MD_PATH,
          scope: "project",
        });
      }
      const expanded = expandSkillReferences(`$ultrathink\n\n${request}`, registry);
      if (!expanded.text || expanded.loaded.length !== 1) {
        if (ctx.hasUI) ctx.ui.notify("Could not load the ultrathink skill.", "error");
        return;
      }

      pi.sendUserMessage(expanded.text, { deliverAs: "followUp" });
    },
  });
}
