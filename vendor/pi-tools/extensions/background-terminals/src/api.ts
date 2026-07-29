import type { TerminalSnapshot } from "./domain.ts";
import type {
  KillResult,
  StartOptions,
  TerminalOutputChunk,
} from "./manager.ts";

export type { TerminalSnapshot } from "./domain.ts";
export type {
  KillResult,
  StartOptions,
  TerminalOutputChunk,
} from "./manager.ts";

export interface BackgroundTerminalService {
  readonly signal: AbortSignal;
  start(options: StartOptions): Promise<TerminalSnapshot>;
  status(id: string): Promise<TerminalSnapshot>;
  list(): Promise<ReadonlyArray<TerminalSnapshot>>;
  kill(ids: ReadonlyArray<string>): Promise<ReadonlyArray<KillResult>>;
  subscribeSettled(
    listener: (snapshot: TerminalSnapshot, consumed: boolean) => void,
  ): () => void;
  subscribeOutput(listener: (event: TerminalOutputChunk) => void): () => void;
}

type ServiceImplementation = Omit<BackgroundTerminalService, "signal">;
type ServiceListener = (service: BackgroundTerminalService) => void;
type ServiceLifetime = {
  readonly service: BackgroundTerminalService;
  abort(): void;
};
type ServiceRegistry = {
  listeners: Set<ServiceListener>;
  active?: ServiceLifetime;
};

// Pi may load extensions through separate module graphs. Symbol.for keeps the
// service bridge process-local but shared across those graphs; shutdown clears
// the active service so no terminal lifecycle survives Pi.
const registryKey = Symbol.for("pi.background-terminal-service.v1");
const globals = globalThis as typeof globalThis & {
  [registryKey]?: ServiceRegistry;
};
const registry = (globals[registryKey] ??= { listeners: new Set() });

export const backgroundTerminalService = {
  subscribe(listener: ServiceListener) {
    registry.listeners.add(listener);
    if (registry.active) {
      try {
        listener(registry.active.service);
      } catch {
        registry.listeners.delete(listener);
      }
    }
    return () => registry.listeners.delete(listener);
  },

  ready() {
    if (registry.active) return Promise.resolve(registry.active.service);
    return new Promise<BackgroundTerminalService>((resolve) => {
      const unsubscribe = this.subscribe((service) => {
        unsubscribe();
        resolve(service);
      });
    });
  },
};

export function provideBackgroundTerminalService(
  implementation: ServiceImplementation,
) {
  registry.active?.abort();
  const controller = new AbortController();
  const service: BackgroundTerminalService = {
    ...implementation,
    signal: controller.signal,
  };
  const lifetime = {
    service,
    abort: () => controller.abort(),
  };
  registry.active = lifetime;
  for (const listener of [...registry.listeners]) {
    try {
      listener(service);
    } catch {
      registry.listeners.delete(listener);
    }
  }
  return {
    service,
    shutdown() {
      lifetime.abort();
      if (registry.active === lifetime) registry.active = undefined;
    },
  };
}
