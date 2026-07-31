import * as fs from "node:fs";
import * as path from "node:path";
import { safeStringify, writeFileAtomic } from "./serialization.ts";
import type { WorkflowDetails } from "./model.ts";

const NAME = "journal.json";
const MAX_EVENTS = 256;
export type JournalEvent = {
  version: 1;
  runId: string;
  generation: number;
  sequence: number;
  timestamp: number;
  phase?: string;
  call?: number;
  transition: string;
  reason?: string;
};
type Journal = {
  version: 1;
  generation: number;
  sequence: number;
  sealed?: boolean;
  events: JournalEvent[];
};

export interface WorkflowJournal {
  generation(): number;
  event(
    transition: string,
    data?: Pick<JournalEvent, "phase" | "call" | "reason">,
  ): boolean;
  seal(reason: string): void;
}

export function createWorkflowJournal(
  runDir: string,
  runId: string,
  persist: (file: string, content: string) => void = writeFileAtomic,
): WorkflowJournal {
  let journal: Journal = { version: 1, generation: 1, sequence: 0, events: [] };
  const save = (next: Journal) => {
    persist(
      path.join(runDir, NAME),
      safeStringify(next, { maxBytes: 128 * 1024 }),
    );
    journal = next;
  };
  const append = (
    source: Journal,
    transition: string,
    data: Pick<JournalEvent, "phase" | "call" | "reason"> = {},
  ) => {
    const sequence = source.sequence + 1;
    const events = [
      ...source.events,
      {
        version: 1 as const,
        runId,
        generation: source.generation,
        sequence,
        timestamp: Date.now(),
        transition,
        ...data,
      },
    ].slice(-MAX_EVENTS);
    return { ...source, sequence, events };
  };
  return {
    generation: () => journal.generation,
    event(transition, data = {}) {
      if (journal.sealed) return false;
      save(append(journal, transition, data));
      return true;
    },
    seal(reason) {
      if (journal.sealed) return;
      save({ ...append(journal, "terminal", { reason }), sealed: true });
    },
  };
}

export function refuseWorkflowResume(runId: string) {
  return `Workflow ${runId}: execution resume unavailable; JavaScript state cannot be replayed safely. Start a new run.`;
}

export function recoverInterruptedWorkflow(runDir: string, active: boolean) {
  if (active) return false;
  const file = path.join(runDir, "workflow.json");
  try {
    const details = JSON.parse(
      fs.readFileSync(file, "utf8"),
    ) as WorkflowDetails;
    if (details.status !== "running") return false;
    details.status = "aborted";
    details.finishedAt ??= Date.now();
    details.error ??=
      "Interrupted by previous process; restart-safe terminal recovery; no execution resume";
    writeFileAtomic(file, safeStringify(details, { maxBytes: 1024 * 1024 }));
    return true;
  } catch {
    return false;
  }
}
