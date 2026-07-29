export function withAbortTimeout(signal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  const timeout = setTimeout(
    () =>
      controller.abort(new Error(`Operation timed out after ${timeoutMs}ms.`)),
    timeoutMs,
  );

  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    },
  };
}

export function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted.");
}
