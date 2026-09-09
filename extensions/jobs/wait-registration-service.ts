import type { JobStateEvent } from "../todo/tool/types.js";

export const MAX_WAIT_REGISTRATIONS = 65_536;

export interface JobWaitRegistration {
  id: string;
  waitToken: string;
  registeredAt: number;
  generation: number;
  incarnation?: string;
  bind?: boolean;
}

export interface JobsWaitRegistrationService {
  register(registrations: readonly JobWaitRegistration[]): JobStateEvent[];
  sync(
    registrations: readonly JobWaitRegistration[],
  ): JobStateEvent[] | undefined;
  query(
    ids: readonly string[],
    registrations?: readonly JobWaitRegistration[],
  ): JobStateEvent[];
}

const KEY = Symbol.for("pi.jobs-wait-registration-service.v1");
type Registry = { service?: JobsWaitRegistrationService };

function registry(): Registry {
  return ((globalThis as typeof globalThis & { [KEY]?: Registry })[KEY] ??= {});
}

export function getJobsWaitRegistrationService():
  JobsWaitRegistrationService | undefined {
  return registry().service;
}

/** Replacing or disposing a host activation cannot revive its stale service. */
export function registerJobsWaitRegistrationService(
  service: JobsWaitRegistrationService,
): () => void {
  const services = registry();
  services.service = service;
  return () => {
    if (services.service === service) services.service = undefined;
  };
}
