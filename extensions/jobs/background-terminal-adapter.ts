import { Writable } from "node:stream";
import {
  backgroundTerminalService,
  type BackgroundTerminalService,
  type TerminalSnapshot,
} from "../../vendor/pi-tools/extensions/background-terminals/src/api.ts";

export interface TerminalOutput {
  stream: "stdout" | "stderr";
  data: string;
}

export interface TerminalSettlement {
  status: "done" | "failed" | "killed";
  exitCode?: number;
  signal?: string;
  errorText?: string;
}

export interface CommandHandle {
  id: string;
  stop(): Promise<void>;
  dispose(): void;
}

function settlement(snapshot: TerminalSnapshot): TerminalSettlement {
  return {
    status: snapshot.status === "running" ? "failed" : snapshot.status,
    ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
    ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
    ...(snapshot.errorText === undefined
      ? {}
      : { errorText: snapshot.errorText }),
  };
}

function sink(
  stream: TerminalOutput["stream"],
  onOutput: (event: TerminalOutput) => void,
) {
  return new Writable({
    decodeStrings: false,
    write(chunk: string | Buffer, _encoding, callback) {
      try {
        onOutput({
          stream,
          data: typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        });
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

export class BackgroundTerminalAdapter {
  private service?: BackgroundTerminalService;
  private unsubscribe?: () => void;
  private waiters = new Set<(service: BackgroundTerminalService) => void>();

  async connect(signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason;
    const abort = () => this.dispose();
    signal?.addEventListener("abort", abort, { once: true });
    this.unsubscribe = backgroundTerminalService.subscribe((service) => {
      if (signal?.aborted) return;
      this.service = service;
      for (const waiter of this.waiters) waiter(service);
      this.waiters.clear();
    });
  }

  private async getService() {
    if (this.service && !this.service.signal.aborted) return this.service;
    return await new Promise<BackgroundTerminalService>((resolve, reject) => {
      const ready = (service: BackgroundTerminalService) => {
        clearTimeout(timer);
        resolve(service);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(ready);
        reject(
          new Error(
            "Background terminal service did not become ready within 5 seconds.",
          ),
        );
      }, 5_000);
      this.waiters.add(ready);
    });
  }

  async start(
    options: { command: string; title: string; cwd: string },
    onOutput: (event: TerminalOutput) => void,
    onSettlement: (event: TerminalSettlement) => void,
  ) {
    const service = await this.getService();
    const stdoutSink = sink("stdout", onOutput);
    const stderrSink = sink("stderr", onOutput);
    const snapshot = await service.start({
      ...options,
      stdoutSink,
      stderrSink,
    });
    const offSettlement = service.subscribeSettled((current) => {
      if (current.id === snapshot.id) onSettlement(settlement(current));
    });
    const current = await service.status(snapshot.id);
    if (current.status !== "running") onSettlement(settlement(current));
    return {
      id: snapshot.id,
      stop: async () => {
        await service.kill([snapshot.id]);
      },
      dispose: () => {
        offSettlement();
        stdoutSink.destroy();
        stderrSink.destroy();
      },
    } satisfies CommandHandle;
  }

  async stop(id: string) {
    await (await this.getService()).kill([id]);
  }

  async status(id: string) {
    return await (await this.getService()).status(id);
  }

  async list() {
    return await (await this.getService()).list();
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.service = undefined;
    this.waiters.clear();
  }
}
