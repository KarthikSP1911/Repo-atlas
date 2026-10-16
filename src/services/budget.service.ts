/**
 * Per-caller call budget: a sliding hour window held in memory (no storage, so it resets on
 * restart). It protects the free tier from a runaway agent loop; it is not security. Callers are
 * identified by the session id the framework puts on the execution context.
 */
export interface BudgetStatus {
  allowed: boolean;
  used: number;
  limit: number;
  /** When the oldest counted call leaves the window and a slot frees up. */
  resetsAt: string;
}

export class CallBudget {
  private readonly calls = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs = 3_600_000,
    private readonly maxCallers = 5_000,
  ) {}

  /** Counts one call for `key` unless the budget is already spent. */
  take(key: string, now = Date.now()): BudgetStatus {
    const status = this.peek(key, now);
    if (!status.allowed) return status;
    const list = this.calls.get(key) ?? [];
    list.push(now);
    this.calls.set(key, list);
    if (this.calls.size > this.maxCallers) this.evict(now);
    return { ...status, used: status.used + 1 };
  }

  /** Current usage without counting a call. */
  peek(key: string, now = Date.now()): BudgetStatus {
    const fresh = (this.calls.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (fresh.length) this.calls.set(key, fresh);
    else this.calls.delete(key);
    const oldest = fresh[0] ?? now;
    return { allowed: fresh.length < this.limit, used: fresh.length, limit: this.limit, resetsAt: new Date(oldest + this.windowMs).toISOString() };
  }

  private evict(now: number): void {
    for (const [k, list] of this.calls) if (!list.some((t) => now - t < this.windowMs)) this.calls.delete(k);
    // Still too many callers: drop the oldest-inserted ones.
    for (const k of this.calls.keys()) {
      if (this.calls.size <= this.maxCallers) break;
      this.calls.delete(k);
    }
  }

  get callers(): number {
    return this.calls.size;
  }
}
