import assert from "node:assert/strict";
import test from "node:test";
import {
  getJobsWaitRegistrationService,
  registerJobsWaitRegistrationService,
} from "./wait-registration-service.ts";
import {
  JobsAdapter,
  JOB_WAIT_REGISTRATION_CHANNEL,
} from "../todo/jobs-adapter.ts";
import { applyJobState } from "../todo/state/waits.ts";

const registration = {
  id: "reused",
  waitToken: "token",
  registeredAt: 1,
  generation: 1,
  bind: true,
};
const incarnation = "00000000-0000-4000-8000-000000000001";

class Bus {
  listeners = new Map();
  on(channel, listener) {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
    return () => listeners.delete(listener);
  }
  emit(channel, value) {
    for (const listener of this.listeners.get(channel) ?? []) listener(value);
  }
}

function waiting(incarnations = {}) {
  return {
    tasks: [
      {
        id: 1,
        subject: "wait",
        status: "waiting:jobs",
        wait: {
          kind: "jobs",
          jobIds: ["reused"],
          mode: "any",
          deadline: 10_000,
          settled: {},
          waitToken: "token",
          registeredAt: 1,
          generation: 1,
          incarnations,
        },
      },
    ],
    nextId: 2,
    revision: 1,
  };
}

test("job waits require direct authenticated incarnation binding", () => {
  const bus = new Bus();
  let busRegistrations = 0;
  bus.on(JOB_WAIT_REGISTRATION_CHANNEL, () => busRegistrations++);
  const adapter = new JobsAdapter(bus);
  const forged = {
    id: "reused",
    status: "succeeded",
    settledAt: 2,
    waitToken: "token",
    waitRegisteredAt: 1,
    waitGeneration: 1,
    waitIncarnation: incarnation,
  };
  assert.equal(
    applyJobState(waiting(), forged).tasks[0].status,
    "waiting:jobs",
  );
  const respond = (registrations) =>
    registrations.map(({ id, waitToken, registeredAt, generation }) => ({
      id,
      status: "running",
      waitToken,
      waitRegisteredAt: registeredAt,
      waitGeneration: generation,
      waitIncarnation: incarnation,
    }));
  const stop = registerJobsWaitRegistrationService({
    register: respond,
    sync: respond,
    query: () => [],
  });
  const response = adapter.register([registration]);
  assert.equal(busRegistrations, 0);
  assert.equal(response[0].waitIncarnation, incarnation);
  const bound = waiting({ reused: response[0].waitIncarnation });
  assert.equal(applyJobState(bound, forged).tasks[0].status, "pending");
  stop();
  adapter.dispose();
});

test("adapter syncs registrations beyond one query batch", () => {
  const bus = new Bus();
  const adapter = new JobsAdapter(bus);
  let received = 0;
  const stop = registerJobsWaitRegistrationService({
    register: () => [],
    sync: (registrations) => {
      received = registrations.length;
      return [];
    },
    query: () => [],
  });
  adapter.register(
    Array.from({ length: 65 }, (_, index) => ({
      ...registration,
      id: `job-${index}`,
      waitToken: `token-${index}`,
    })),
  );
  assert.equal(received, 65);
  stop();
  adapter.dispose();
});

test("stale jobs host disposal cannot clear replacement registration service", () => {
  const first = registerJobsWaitRegistrationService({
    register: () => [],
    sync: () => [],
    query: () => [],
  });
  const secondService = { register: () => [], sync: () => [], query: () => [] };
  const second = registerJobsWaitRegistrationService(secondService);
  first();
  assert.equal(getJobsWaitRegistrationService(), secondService);
  second();
  assert.equal(getJobsWaitRegistrationService(), undefined);
});

test("reused IDs cannot rebind persisted registrations", () => {
  const persisted = waiting({ reused: incarnation });
  const replacement = {
    ...registration,
    incarnation: "00000000-0000-4000-8000-000000000002",
  };
  assert.equal(
    applyJobState(persisted, {
      id: "reused",
      status: "succeeded",
      settledAt: 2,
      waitToken: replacement.waitToken,
      waitRegisteredAt: replacement.registeredAt,
      waitGeneration: replacement.generation,
      waitIncarnation: replacement.incarnation,
    }).tasks[0].status,
    "waiting:jobs",
  );
});
