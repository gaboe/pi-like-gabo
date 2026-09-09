export interface PackageAssignmentRequest {
  todoId: number;
  todoToken: string;
  workerCwd: string;
  targetBinding: string;
}

export interface PackageAssignmentAuthorization extends PackageAssignmentRequest {
  subagentId: string;
}

export type PackageAssignmentGate = (
  request: PackageAssignmentRequest,
) => string | undefined;
export type PackageAssignmentAuthorizer = (
  authorization: PackageAssignmentAuthorization,
) => void;
export type PackageAssignmentRollback = (
  authorization: PackageAssignmentAuthorization,
  reason: string,
) => void;

export interface PackageAssignmentLease {
  validate(): string | undefined;
  authorize(subagentId: string): string | undefined;
  rollback(subagentId: string, reason: string): string | undefined;
  close(): void;
}

const KEY = Symbol.for("pi.package-assignment-gate.v1");
const GATE_UNAVAILABLE = "package_handoff assignment gate unavailable.";
const AUTHORIZER_UNAVAILABLE =
  "package_handoff assignment authorizer unavailable.";
const ROLLBACK_UNAVAILABLE = "package_handoff assignment rollback unavailable.";
const GATE_CHANGED = "package_handoff assignment gate changed during spawn.";
const ACQUISITION_ABORTED =
  "package_handoff assignment acquisition was aborted.";
const ALREADY_SPAWNING =
  "package_handoff assignment is already spawning for this TODO.";

function invalidRequest(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "package_handoff assignment requires a canonical worker cwd and target binding.";
  const request = value as Record<string, unknown>;
  if (
    typeof request.workerCwd !== "string" ||
    !request.workerCwd.startsWith("/") ||
    !request.workerCwd.trim()
  )
    return "package_handoff assignment requires a canonical worker cwd.";
  if (
    typeof request.targetBinding !== "string" ||
    !/^[a-f0-9]{64}$/i.test(request.targetBinding)
  )
    return "package_handoff assignment requires the current prepared target binding.";
  return undefined;
}

type Waiter = {
  request: PackageAssignmentRequest;
  gate: PackageAssignmentGate;
  generation: number;
  resolve(result: PackageAssignmentLease | string): void;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
};

type Registry = {
  gate?: PackageAssignmentGate;
  authorize?: PackageAssignmentAuthorizer;
  rollback?: PackageAssignmentRollback;
  generation: number;
  leases: Map<string, symbol>;
  waiters: Map<string, Waiter[]>;
};

function registry(): Registry {
  const root = globalThis as typeof globalThis & { [KEY]?: Registry };
  const state = (root[KEY] ??= {
    generation: 0,
    leases: new Map(),
    waiters: new Map(),
  });
  state.leases ??= new Map();
  state.waiters ??= new Map();
  return state;
}

function requestKey(request: PackageAssignmentRequest): string {
  return JSON.stringify([request.todoId, request.todoToken]);
}

function settleWaiter(
  waiter: Waiter,
  result: PackageAssignmentLease | string,
): void {
  if (waiter.settled) return;
  waiter.settled = true;
  if (waiter.onAbort)
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
  waiter.resolve(result);
}

function failWaiters(state: Registry, fallback: string): void {
  const waiters = [...state.waiters.values()].flat();
  state.waiters.clear();
  for (const waiter of waiters) {
    settleWaiter(waiter, packageAssignmentError(waiter.request) ?? fallback);
  }
}

function createLease(
  state: Registry,
  request: PackageAssignmentRequest,
  key: string,
  gate: PackageAssignmentGate,
  generation: number,
): PackageAssignmentLease {
  const owner = Symbol();
  const authorize = state.authorize;
  const rollback = state.rollback;
  state.leases.set(key, owner);
  let closed = false;
  let authorizedSubagentId: string | undefined;
  const release = () => {
    if (closed) return;
    closed = true;
    if (state.leases.get(key) === owner) {
      state.leases.delete(key);
      wakeNext(state, key);
    }
  };
  const validate = () => {
    let error: string | undefined;
    if (
      closed ||
      state.generation !== generation ||
      state.gate !== gate ||
      state.leases.get(key) !== owner
    ) {
      error = GATE_CHANGED;
    } else {
      error = packageAssignmentError(request);
    }
    if (error) release();
    return error;
  };
  return {
    validate,
    authorize(subagentId) {
      const error = validate();
      if (error) return error;
      if (!authorize) {
        release();
        return AUTHORIZER_UNAVAILABLE;
      }
      if (!rollback) {
        release();
        return ROLLBACK_UNAVAILABLE;
      }
      try {
        authorize({ ...request, subagentId });
        authorizedSubagentId = subagentId;
        return undefined;
      } catch {
        release();
        return "package_handoff assignment gate rejected authorization.";
      }
    },
    rollback(subagentId, reason) {
      if (authorizedSubagentId !== subagentId)
        return "package_handoff assignment rollback was not authorized.";
      if (!rollback) {
        release();
        return ROLLBACK_UNAVAILABLE;
      }
      try {
        rollback({ ...request, subagentId }, reason);
        return undefined;
      } catch {
        return "package_handoff assignment rollback was rejected.";
      } finally {
        release();
      }
    },
    close: release,
  };
}

function wakeNext(state: Registry, key: string): void {
  if (state.leases.has(key)) return;
  const queue = state.waiters.get(key);
  while (queue?.length) {
    const waiter = queue.shift()!;
    if (queue.length === 0) state.waiters.delete(key);
    if (waiter.settled) continue;
    if (waiter.generation !== state.generation || waiter.gate !== state.gate) {
      settleWaiter(
        waiter,
        packageAssignmentError(waiter.request) ?? GATE_CHANGED,
      );
      continue;
    }
    const error = packageAssignmentError(waiter.request);
    if (error) {
      settleWaiter(waiter, error);
      continue;
    }
    settleWaiter(
      waiter,
      createLease(state, waiter.request, key, waiter.gate, waiter.generation),
    );
    return;
  }
  state.waiters.delete(key);
}

export function registerPackageAssignmentGate(
  gate: PackageAssignmentGate,
  authorize: PackageAssignmentAuthorizer,
  rollback: PackageAssignmentRollback,
): () => void {
  const state = registry();
  const generation = ++state.generation;
  state.leases.clear();
  state.gate = gate;
  state.authorize = authorize;
  state.rollback = rollback;
  failWaiters(state, GATE_CHANGED);
  return () => {
    if (state.generation !== generation || state.gate !== gate) return;
    delete state.gate;
    delete state.authorize;
    delete state.rollback;
    state.leases.clear();
    state.generation++;
    failWaiters(state, GATE_UNAVAILABLE);
  };
}

export function packageAssignmentError(
  request: PackageAssignmentRequest,
): string | undefined {
  const requestError = invalidRequest(request);
  if (requestError) return requestError;
  const gate = registry().gate;
  if (!gate) return GATE_UNAVAILABLE;
  try {
    return gate(request);
  } catch {
    return "package_handoff assignment gate rejected the assignment.";
  }
}

export function acquirePackageAssignmentLease(
  request: PackageAssignmentRequest,
): PackageAssignmentLease | string {
  const state = registry();
  const gate = state.gate;
  const generation = state.generation;
  const initialError = packageAssignmentError(request);
  if (initialError || !gate) return initialError ?? GATE_UNAVAILABLE;
  const key = requestKey(request);
  if (state.leases.has(key) || state.waiters.has(key)) return ALREADY_SPAWNING;
  return createLease(state, request, key, gate, generation);
}

export function acquirePackageAssignmentLeaseAsync(
  request: PackageAssignmentRequest,
  signal?: AbortSignal,
): Promise<PackageAssignmentLease | string> {
  const state = registry();
  const gate = state.gate;
  const generation = state.generation;
  const initialError = packageAssignmentError(request);
  if (initialError || !gate)
    return Promise.resolve(initialError ?? GATE_UNAVAILABLE);
  if (signal?.aborted) return Promise.resolve(ACQUISITION_ABORTED);

  const key = requestKey(request);
  if (!state.leases.has(key) && !state.waiters.has(key)) {
    return Promise.resolve(createLease(state, request, key, gate, generation));
  }

  return new Promise((resolve) => {
    const waiter: Waiter = {
      request,
      gate,
      generation,
      resolve,
      signal,
      settled: false,
    };
    const onAbort = () => {
      if (waiter.settled) return;
      const queue = state.waiters.get(key);
      const index = queue?.indexOf(waiter) ?? -1;
      if (index >= 0) queue!.splice(index, 1);
      if (queue?.length === 0) state.waiters.delete(key);
      settleWaiter(waiter, ACQUISITION_ABORTED);
      wakeNext(state, key);
    };
    waiter.onAbort = onAbort;
    const queue = state.waiters.get(key) ?? [];
    queue.push(waiter);
    state.waiters.set(key, queue);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
