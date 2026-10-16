import { afterEach, describe, expect, it } from 'vitest';
import { CallBudget } from '../src/services/budget.service.js';
import { CallBudgetGuard, Policies, callerKey } from '../src/policies.js';
import { SnapshotsHealthCheck } from '../src/health/snapshots.health.js';
import { POLICIES } from '../src/config/weights.js';

const T0 = Date.parse('2026-10-16T12:00:00Z');

describe('CallBudget', () => {
  it('counts calls per caller within a sliding window and refuses over the limit', () => {
    const b = new CallBudget(3, 1000);
    expect(b.take('a', T0)).toMatchObject({ allowed: true, used: 1, limit: 3 });
    b.take('a', T0 + 100);
    expect(b.take('a', T0 + 200)).toMatchObject({ allowed: true, used: 3 });
    const refused = b.take('a', T0 + 300);
    expect(refused).toMatchObject({ allowed: false, used: 3 });
    expect(refused.resetsAt).toBe(new Date(T0 + 1000).toISOString());
    expect(b.take('b', T0 + 300).allowed).toBe(true); // other callers are independent
  });

  it('frees slots as old calls leave the window', () => {
    const b = new CallBudget(2, 1000);
    b.take('a', T0);
    b.take('a', T0 + 500);
    expect(b.take('a', T0 + 900).allowed).toBe(false);
    expect(b.take('a', T0 + 1001)).toMatchObject({ allowed: true, used: 2 }); // the call at T0 expired
  });

  it('peek does not count, and a refused call is not counted', () => {
    const b = new CallBudget(1, 1000);
    expect(b.peek('a', T0).used).toBe(0);
    b.take('a', T0);
    b.take('a', T0 + 1);
    expect(b.peek('a', T0 + 2).used).toBe(1);
  });

  it('forgets callers whose calls have all expired and caps the number of callers', () => {
    const b = new CallBudget(5, 1000, 3);
    for (const k of ['a', 'b', 'c']) b.take(k, T0);
    b.take('d', T0 + 5000); // a, b, c expired by now
    expect(b.callers).toBeLessThanOrEqual(3);
    const many = new CallBudget(5, 10_000, 3);
    for (const k of ['a', 'b', 'c', 'd', 'e']) many.take(k, T0);
    expect(many.callers).toBeLessThanOrEqual(3);
  });
});

describe('CallBudgetGuard and callerKey', () => {
  const saved = CallBudgetGuard.budget;
  afterEach(() => {
    CallBudgetGuard.budget = saved;
  });

  it('keys by session, then auth subject, then anonymous', () => {
    expect(callerKey({ sessionId: 'anon:s1', auth: { subject: 'u' } } as never)).toBe('anon:s1');
    expect(callerKey({ auth: { subject: 'u' } } as never)).toBe('u');
    expect(callerKey({} as never)).toBe('anonymous');
    expect(callerKey(undefined)).toBe('anonymous');
  });

  it('allows calls within budget and throws a helpful error when it is spent', () => {
    CallBudgetGuard.budget = new CallBudget(2, 3_600_000);
    const g = new CallBudgetGuard();
    const ctx = { sessionId: 'anon:x' } as never;
    expect(g.canActivate(ctx)).toBe(true);
    expect(g.canActivate(ctx)).toBe(true);
    expect(() => g.canActivate(ctx)).toThrow(/Call budget reached: 2 of 2.*Wait until .*loop/s);
    expect(g.canActivate({ sessionId: 'anon:other' } as never)).toBe(true);
  });
});

describe('Policies decorator', () => {
  it('is a no-op under vitest so tool methods stay directly callable and deterministic', async () => {
    const original = async (x: number): Promise<number> => x + 1;
    const descriptor: PropertyDescriptor = { value: original, writable: true, configurable: true };
    const out = Policies({ cacheTtl: 60, perMinute: 1 })({}, 'method', descriptor) as PropertyDescriptor;
    expect(out.value).toBe(original);
    expect(await out.value(1)).toBe(2);
    expect(await out.value(1)).toBe(2);
    expect(await out.value(1)).toBe(2); // not rate limited
  });

  it('has sane policy values', () => {
    expect(POLICIES.readCallsPerMinute).toBeGreaterThanOrEqual(30);
    expect(POLICIES.exportCallsPerMinute).toBeLessThan(POLICIES.readCallsPerMinute);
    expect(POLICIES.sessionCallBudgetPerHour).toBeGreaterThan(POLICIES.readCallsPerMinute);
  });
});

describe('SnapshotsHealthCheck', () => {
  it('reports up with the shipped snapshots', async () => {
    const r = await new SnapshotsHealthCheck().check();
    expect(r.status).toBe('up');
    expect((r.details as { snapshots: number; rejected: string[] }).snapshots).toBeGreaterThanOrEqual(4);
    expect((r.details as { rejected: string[] }).rejected).toEqual([]);
  });

  it('reports down when there are no snapshots', async () => {
    const h = new SnapshotsHealthCheck();
    (h as unknown as { store: { dir: string } }).store.dir = 'does/not/exist';
    const r = await h.check();
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/No snapshots/);
  });
});
