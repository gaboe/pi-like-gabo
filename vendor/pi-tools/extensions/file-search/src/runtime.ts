import { NodeServices } from "@effect/platform-node";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cause, Data, Effect, Exit } from "effect";
import {
  currentTarget,
  liveBinaryEnv,
  repositoryBinDir,
  resolveBinary,
  TOOL_SPECS,
  type BinaryEnv,
  type BinarySource,
  type PlatformTarget,
  type ResolvedBinary,
} from "./binaries.ts";
import { formatCapturedOutput, type CapturedOutput } from "./output.ts";
import { discardCapturedOutput, executeSearchProcess } from "./process.ts";

export function makeBinaryInitializers(
  binDir: string,
  target: PlatformTarget,
  env: BinaryEnv,
) {
  return {
    fd: Effect.runSync(
      Effect.cached(resolveBinary(TOOL_SPECS.fd, binDir, target, env)),
    ),
    rg: Effect.runSync(
      Effect.cached(resolveBinary(TOOL_SPECS.rg, binDir, target, env)),
    ),
  };
}

export function installNotifications(binaries: readonly ResolvedBinary[]) {
  return binaries
    .filter((binary) => binary.source === "installed")
    .map(
      (binary) =>
        `file-search: no system ${binary.tool} found — downloaded ${binary.tool} ${binary.version ?? ""}`.trimEnd() +
        ` to ${repositoryBinDir()}`,
    );
}

class SearchError extends Data.TaggedError("SearchError")<{
  readonly message: string;
}> {}

interface SearchOutcome {
  readonly output: CapturedOutput;
  readonly noMatches: boolean;
  readonly binarySource: BinarySource;
}

const EXEC_TIMEOUT_MS = 60_000;

function causeMessage<E>(cause: Cause.Cause<E>) {
  const [first] = Cause.prettyErrors(cause);
  return first?.message ?? Cause.pretty(cause);
}

function unwrapToolExit<A, E>(exit: Exit.Exit<A, E>, tool: "fd" | "rg") {
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause))
    throw new Error(`${tool} search was cancelled.`);
  throw new Error(causeMessage(exit.cause));
}

const initializers = makeBinaryInitializers(
  repositoryBinDir(),
  currentTarget(),
  liveBinaryEnv,
);

export async function executeSearch(
  tool: "fd" | "rg",
  args: string[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onInstalled: (binary: ResolvedBinary) => void,
) {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const binary = yield* initializers[tool];
      if (binary.source === "installed") onInstalled(binary);
      const result = yield* executeSearchProcess({
        command: binary.command,
        args,
        cwd: ctx.cwd,
        tempPrefix: `pi-${tool}-`,
      });
      if (tool === "rg" && result.code === 1 && result.output.lineCount === 0) {
        return {
          output: result.output,
          noMatches: true,
          binarySource: binary.source,
        } satisfies SearchOutcome;
      }
      if (result.code !== 0) {
        yield* discardCapturedOutput(result.output);
        return yield* new SearchError({
          message: `${tool} failed: ${result.stderr.trim() || `exit code ${result.code}`}`,
        });
      }
      return {
        output: result.output,
        noMatches: result.output.lineCount === 0,
        binarySource: binary.source,
      } satisfies SearchOutcome;
    }).pipe(
      Effect.timeout(EXEC_TIMEOUT_MS),
      Effect.mapError((error) =>
        error instanceof SearchError
          ? error
          : new SearchError({
              message:
                error._tag === "TimeoutError"
                  ? `${tool} timed out.`
                  : error instanceof Error
                    ? error.message
                    : String(error),
            }),
      ),
      Effect.provide(NodeServices.layer),
    ),
    signal ? { signal } : undefined,
  );
  const outcome = unwrapToolExit(exit, tool);
  if (outcome.noMatches) return { outcome, formatted: undefined };
  return { outcome, formatted: formatCapturedOutput(outcome.output) };
}
