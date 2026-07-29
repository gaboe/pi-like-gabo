import type { Theme } from "@earendil-works/pi-coding-agent";

export const COMPACT_TOOL_RENDERER_KEY = Symbol.for(
  "pi.compact-tool-renderer.v1",
);

export interface CompactToolEntry {
  toolId: string;
  name: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
  running?: boolean;
  durationMs?: number;
}

export interface CompactToolRendererApi {
  version: 1;
  enabled(): boolean;
  render(
    entries: ReadonlyArray<CompactToolEntry>,
    options: { cwd: string; width: number; theme: Theme },
  ): string[];
}

export function getCompactToolRenderer(): CompactToolRendererApi | undefined {
  return (
    globalThis as typeof globalThis & {
      [COMPACT_TOOL_RENDERER_KEY]?: CompactToolRendererApi;
    }
  )[COMPACT_TOOL_RENDERER_KEY];
}

export function setCompactToolRenderer(api: CompactToolRendererApi): void {
  (
    globalThis as typeof globalThis & {
      [COMPACT_TOOL_RENDERER_KEY]?: CompactToolRendererApi;
    }
  )[COMPACT_TOOL_RENDERER_KEY] = api;
}
