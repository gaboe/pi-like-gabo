import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { JobStateEvent } from "./tool/types.js";
import { normalizeJobStateEvent } from "./state/waits.js";
import { MAX_WAIT_JOB_COUNT } from "./tool/types.js";
import {
  getJobsWaitRegistrationService,
  MAX_WAIT_REGISTRATIONS,
  type JobWaitRegistration,
} from "../jobs/wait-registration-service.js";

export const JOB_STATE_CHANNEL = "jobs:state";
export const JOB_QUERY_CHANNEL = "jobs:query";
export const JOB_WAIT_REGISTRATION_CHANNEL = "jobs:wait-registration";

export interface JobQueryRequest {
  ids: string[];
  registrations?: readonly JobWaitRegistration[];
  respond(value: unknown): void;
}

/** The only jobs-extension protocol seam used by todo. */
export class JobsAdapter {
  private readonly listeners = new Set<(event: JobStateEvent) => void>();
  private stop: (() => void) | undefined;
  private generation = 0;

  constructor(private readonly events: EventBus) {
    this.activate();
  }

  activate(): void {
    if (this.stop) return;
    const generation = ++this.generation;
    this.stop = this.events.on(JOB_STATE_CHANNEL, (value) => {
      if (generation !== this.generation) return;
      const event = normalizeJobStateEvent(value);
      if (!event) return;
      for (const listener of this.listeners) listener(event);
    });
  }

  onState(listener: (event: JobStateEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Undefined means no active jobs host authenticated this registration. */
  register(
    registrations: readonly JobWaitRegistration[],
  ): JobStateEvent[] | undefined {
    return getJobsWaitRegistrationService()?.sync(registrations);
  }

  async query(
    ids: readonly string[],
    timeoutMs = 100,
    registrations?: readonly JobWaitRegistration[],
  ): Promise<JobStateEvent[] | undefined> {
    const requestedIds: string[] = [];
    const requested = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || !id) return undefined;
      if (requested.has(id)) continue;
      if (requestedIds.length === MAX_WAIT_JOB_COUNT) return undefined;
      requested.add(id);
      requestedIds.push(id);
    }
    if (requestedIds.length === 0) return [];
    const suppliedRegistrations = registrations ?? [];
    if (suppliedRegistrations.length > MAX_WAIT_REGISTRATIONS) return undefined;
    const registrationKey = (registration: JobWaitRegistration) =>
      JSON.stringify([
        registration.id,
        registration.waitToken,
        registration.registeredAt,
        registration.generation,
      ]);
    if (
      suppliedRegistrations.some(
        (registration) =>
          !requested.has(registration.id) ||
          !registration.waitToken ||
          !Number.isFinite(registration.registeredAt) ||
          !Number.isSafeInteger(registration.generation) ||
          registration.generation < 1 ||
          (registration.incarnation !== undefined &&
            (typeof registration.incarnation !== "string" ||
              !registration.incarnation)) ||
          (registration.bind !== undefined && registration.bind !== true),
      ) ||
      new Set(suppliedRegistrations.map(registrationKey)).size !==
        suppliedRegistrations.length
    )
      return undefined;
    const host = getJobsWaitRegistrationService();
    let result: unknown | undefined;
    if (host && suppliedRegistrations.length)
      result = host.query(requestedIds, suppliedRegistrations);
    else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      result = await new Promise<unknown | undefined>((resolve) => {
        let answered = false;
        const respond = (value: unknown) => {
          if (answered) return;
          answered = true;
          if (timer) clearTimeout(timer);
          resolve(value);
        };
        timer = setTimeout(() => respond(undefined), timeoutMs);
        this.events.emit(JOB_QUERY_CHANNEL, {
          ids: requestedIds,
          ...(suppliedRegistrations.length
            ? { registrations: suppliedRegistrations }
            : {}),
          respond,
        } satisfies JobQueryRequest);
      });
    }
    if (result === undefined) return undefined;
    const values = Array.isArray(result)
      ? result
      : result &&
          typeof result === "object" &&
          Array.isArray((result as { jobs?: unknown }).jobs)
        ? (result as { jobs: unknown[] }).jobs
        : [];
    if (values.length > MAX_WAIT_REGISTRATIONS) return undefined;
    const requestedRegistrations = new Map(
      suppliedRegistrations
        .filter((registration) => requested.has(registration.id))
        .map((registration) => [registrationKey(registration), registration]),
    );
    if (requestedRegistrations.size !== suppliedRegistrations.length)
      return undefined;
    const requestedRegistrationIds = new Set(
      [...requestedRegistrations.values()].map(({ id }) => id),
    );
    const seen = new Set<string>();
    const events: JobStateEvent[] = [];
    for (const value of values) {
      const event = normalizeJobStateEvent(value);
      if (!event || !requested.has(event.id)) return undefined;
      const key =
        event.waitToken === undefined
          ? `unregistered:${event.id}`
          : registrationKey({
              id: event.id,
              waitToken: event.waitToken,
              registeredAt: event.waitRegisteredAt!,
              generation: event.waitGeneration!,
            });
      if (
        seen.has(key) ||
        (event.waitToken === undefined
          ? requestedRegistrationIds.has(event.id)
          : !requestedRegistrations.has(key))
      )
        return undefined;
      seen.add(key);
      events.push(event);
    }
    return events;
  }

  async validateRunning(ids: readonly string[]): Promise<string | undefined> {
    const queried = await this.query(ids);
    if (!queried) return "jobs query unavailable";
    for (const id of ids) {
      const job = queried.find(
        (event) => event.id === id && event.waitToken === undefined,
      );
      if (!job) return `job ${id} not found`;
      if (job.status !== "running") return `job ${id} is already ${job.status}`;
    }
    return undefined;
  }

  dispose(): void {
    this.generation++;
    this.stop?.();
    this.stop = undefined;
    this.listeners.clear();
  }
}
