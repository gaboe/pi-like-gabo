import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import path from "node:path";
import { collectCapabilityRecords, createDiscoveryAdapters, formatDoctorReport } from "./doctor.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

export default function piDoctor(pi: ExtensionAPI): void {
  const report = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const provider = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const adapters = createDiscoveryAdapters(pi, PACKAGE_ROOT, ctx.cwd, provider);
    const lines = formatDoctorReport(collectCapabilityRecords(adapters)).split("\n");
    await ctx.ui.custom(
      (tui, theme, _keybindings, done) => {
        let offset = 0;
        const pageHeight = () => Math.max(1, Math.floor(tui.terminal.rows * 0.9) - 1);
        const move = (delta: number) => {
          offset = Math.max(0, Math.min(Math.max(0, lines.length - pageHeight()), offset + delta));
          tui.requestRender();
        };
        return {
          render: (width: number) => {
            const page = lines.slice(offset, offset + pageHeight());
            return [
              ...page.map((line, index) => index === 0 && offset === 0
                ? theme.fg("accent", truncateToWidth(line, width, "…"))
                : truncateToWidth(line, width, "…")),
              truncateToWidth(`↑↓/jk scroll · PgUp/PgDn or u/d page · Home/End · ${offset + 1}-${offset + page.length}/${lines.length} · Esc/q/Enter close`, width, "…"),
            ];
          },
          handleInput: (data: string) => {
            if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.enter)) done(undefined);
            else if (matchesKey(data, Key.up) || data === "k") move(-1);
            else if (matchesKey(data, Key.down) || data === "j") move(1);
            else if (matchesKey(data, Key.pageUp) || data === "u") move(-pageHeight());
            else if (matchesKey(data, Key.pageDown) || data === "d") move(pageHeight());
            else if (matchesKey(data, Key.home)) move(-lines.length);
            else if (matchesKey(data, Key.end)) move(lines.length);
          },
          invalidate: () => {},
        };
      },
      { overlay: true, overlayOptions: { anchor: "center", margin: 1, maxHeight: "90%", minWidth: 60, width: "90%" } },
    );
  };

  pi.registerCommand("pi-doctor", {
    description: "Report package capabilities and safe health probes without changing anything",
    handler: report,
  });
  pi.registerCommand("capabilities", {
    description: "Alias for /pi-doctor capability details",
    handler: report,
  });
}
