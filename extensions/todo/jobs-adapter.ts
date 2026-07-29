import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { JobStateEvent } from "./tool/types.js";
import { isJobStateEvent } from "./state/waits.js";

export const JOB_STATE_CHANNEL = "jobs:state";
export const JOB_QUERY_CHANNEL = "jobs:query";

export interface JobQueryRequest {
	ids: string[];
	respond(value: unknown): void;
}

/** The only jobs-extension protocol seam used by todo. */
export class JobsAdapter {
	private readonly cache = new Map<string, JobStateEvent>();
	private readonly listeners = new Set<(event: JobStateEvent) => void>();
	private readonly stop: () => void;

	constructor(private readonly events: EventBus) {
		this.stop = events.on(JOB_STATE_CHANNEL, (value) => {
			if (!isJobStateEvent(value)) return;
			this.cache.set(value.id, value);
			for (const listener of this.listeners) listener(value);
		});
	}

	onState(listener: (event: JobStateEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Optional callback query. Undefined means no jobs extension answered. */
	async query(ids: readonly string[], timeoutMs = 100): Promise<Map<string, JobStateEvent> | undefined> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const result = await new Promise<unknown | undefined>((resolve) => {
			let answered = false;
			const respond = (value: unknown) => {
				if (answered) return;
				answered = true;
				if (timer) clearTimeout(timer);
				resolve(value);
			};
			timer = setTimeout(() => respond(undefined), timeoutMs);
			this.events.emit(JOB_QUERY_CHANNEL, { ids: [...ids], respond } satisfies JobQueryRequest);
		});
		if (result === undefined) return undefined;
		const values = Array.isArray(result)
			? result
			: result && typeof result === "object" && Array.isArray((result as { jobs?: unknown }).jobs)
				? (result as { jobs: unknown[] }).jobs
				: [];
		const jobs = new Map<string, JobStateEvent>();
		for (const value of values) {
			if (!isJobStateEvent(value)) continue;
			jobs.set(value.id, value);
			this.cache.set(value.id, value);
		}
		return jobs;
	}

	async validateRunning(ids: readonly string[]): Promise<string | undefined> {
		const queried = await this.query(ids);
		if (!queried) return "jobs query unavailable";
		for (const id of ids) {
			const job = queried.get(id);
			if (!job) return `job ${id} not found`;
			if (job.status !== "running") return `job ${id} is already ${job.status}`;
		}
		return undefined;
	}

	dispose(): void {
		this.stop();
		this.listeners.clear();
	}
}
