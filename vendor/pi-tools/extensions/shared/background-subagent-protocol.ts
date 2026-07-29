import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const BACKGROUND_SUBAGENT_SERVICE_KEY = Symbol.for(
  "pi.background-subagent-service.v1",
);

export interface BackgroundSubagentProgress {
  id: string;
  stage: string;
  subject?: string;
  at: number;
}

export interface BackgroundSubagentRequest {
  prompt: string;
  title: string;
  cwd: string;
  model?: string;
  reasoningEffort?:
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns?: number;
  timeoutMs?: number;
  allowedTools?: string[];
  readOnlyBash?: boolean;
  noExtensions?: boolean;
  onSpawn?: (id: string) => void;
  onProgress?: (progress: BackgroundSubagentProgress) => void;
  parent: {
    parentCwd: string;
    projectTrusted: boolean;
    inheritedModel?: { provider: string; id: string };
    inheritedThinkingLevel?: string;
    modelRegistry: ModelRegistry;
  };
}

export interface BackgroundSubagentResult {
  id: string;
  status: "done" | "error";
  output: string;
  error?: string;
}

export interface BackgroundSubagentService {
  run(request: BackgroundSubagentRequest): Promise<BackgroundSubagentResult>;
  cancel?(ids: readonly string[]): Promise<unknown>;
}

interface BackgroundSubagentRegistry {
  services: BackgroundSubagentService[];
}

type RuntimeGlobal = typeof globalThis & {
  [BACKGROUND_SUBAGENT_SERVICE_KEY]?: BackgroundSubagentRegistry;
};

function registry(): BackgroundSubagentRegistry {
  const runtime = globalThis as RuntimeGlobal;
  return (runtime[BACKGROUND_SUBAGENT_SERVICE_KEY] ??= { services: [] });
}

export function getBackgroundSubagentService():
  BackgroundSubagentService | undefined {
  return registry().services.at(-1);
}

export function registerBackgroundSubagentService(
  service: BackgroundSubagentService,
): () => void {
  const services = registry().services;
  services.push(service);
  return () => {
    const index = services.lastIndexOf(service);
    if (index >= 0) services.splice(index, 1);
  };
}
