export const DEFAULT_COST_WARNING_THRESHOLD = 10;

export function parseCostWarningThreshold(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return DEFAULT_COST_WARNING_THRESHOLD;
  const threshold = Number(value);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : undefined;
}

export class CostWarningPolicy {
  private warned = false;

  constructor(readonly threshold = parseCostWarningThreshold(process.env.PI_COST_WARNING_THRESHOLD)) {}

  observe(cost: unknown): boolean {
    if (this.threshold === undefined || typeof cost !== "number" || !Number.isFinite(cost)) return false;
    if (cost < this.threshold) {
      this.warned = false;
      return false;
    }
    if (this.warned) return false;
    this.warned = true;
    return true;
  }

  reset() {
    this.warned = false;
  }

  state(cost: unknown) {
    return { threshold: this.threshold, current: typeof cost === "number" && Number.isFinite(cost) ? cost : undefined, warned: this.warned };
  }
}
