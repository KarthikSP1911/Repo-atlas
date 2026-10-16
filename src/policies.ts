import { Cache, RateLimit, UseGuards, type ExecutionContext } from '@nitrostack/core';
import { POLICIES } from './config/weights.js';
import { CallBudget } from './services/budget.service.js';

/**
 * Runtime policies for tools, applied with one decorator: `@Policies({ cacheTtl: 300 })`.
 * Order of effect on a call: session call budget, then per-caller rate limit, then the result
 * cache (a cached answer still counts toward the budget and the rate limit).
 *
 * Under vitest the decorator does nothing, so unit tests that call tool methods directly stay
 * deterministic (the cache and rate limiter keep module-level state). The real behaviour is
 * verified against a running server over /mcp.
 */

/** Who is calling: the framework's per-session isolation key, else the auth subject, else anonymous. */
export function callerKey(ctx: ExecutionContext | undefined): string {
  return ctx?.sessionId || ctx?.auth?.subject || 'anonymous';
}

/** Shared by every guarded tool so one caller has one budget across all tools. */
export const sessionBudget = new CallBudget(POLICIES.sessionCallBudgetPerHour);

export class CallBudgetGuard {
  /** Overridable in tests. */
  static budget: CallBudget = sessionBudget;

  canActivate(context: ExecutionContext): boolean {
    const status = CallBudgetGuard.budget.take(callerKey(context));
    if (!status.allowed) {
      throw new Error(`Call budget reached: ${status.used} of ${status.limit} RepoAtlas tool calls used in the last hour for this session. Wait until ${status.resetsAt} or stop calling tools in a loop. This limit protects the free tier.`);
    }
    return true;
  }
}

export interface PolicyOptions {
  /** Cache the result this many seconds. Omit for tools whose output must never be reused. */
  cacheTtl?: number;
  /** Calls per minute per caller. Default: POLICIES.readCallsPerMinute. */
  perMinute?: number;
}

type MethodDecoratorFn = (target: object, key: string | symbol, descriptor: PropertyDescriptor) => PropertyDescriptor | void;

export function Policies(options: PolicyOptions = {}): MethodDecoratorFn {
  return (target, key, descriptor) => {
    if (process.env.VITEST) return descriptor;
    const perMinute = options.perMinute ?? POLICIES.readCallsPerMinute;
    let d = descriptor;
    // Decorators wrap from the inside out: cache innermost, then the rate limit.
    if (options.cacheTtl) d = (Cache({ ttl: options.cacheTtl })(target, key, d) as PropertyDescriptor | undefined) ?? d;
    d =
      (RateLimit({
        requests: perMinute,
        window: '1m',
        key: callerKey,
        message: `Rate limit reached: at most ${perMinute} calls per minute per session. Wait a minute and try again.`,
      })(target, key, d) as PropertyDescriptor | undefined) ?? d;
    // The tool runner executes guards before anything else.
    UseGuards(CallBudgetGuard)(target, key as string, d);
    return d;
  };
}
