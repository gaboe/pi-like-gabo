/** Pi-only runtime composition. */

import { Cause, Exit, Layer, ManagedRuntime, type Effect } from "effect";
import { BackendRegistry } from "./backend.ts";
import { piBackend } from "./backends/pi.ts";
import { SubagentManagerLive } from "./manager.ts";

const BackendRegistryLive = Layer.sync(
  BackendRegistry,
  () => new Map([["pi", piBackend]]),
);
const AppLayer = SubagentManagerLive.pipe(Layer.provide(BackendRegistryLive));

export function createSubagentRuntime() {
  return ManagedRuntime.make(AppLayer);
}
export type SubagentRuntime = ReturnType<typeof createSubagentRuntime>;

export async function runTool<A, E>(
  runtime: SubagentRuntime,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal; interruptMessage?: string } = {},
) {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause))
    throw new Error(options.interruptMessage ?? "Operation was aborted.");
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
