import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CANDIDATES } from '../src/config/weights.js';
import { findCandidates, freshnessOf, newRefreshState, refreshIssues } from '../src/services/candidates.service.js';
import { claimEvidence, clarityOf, daysBetween } from '../src/services/issues.service.js';
import type { IssuesFile, OpenIssue } from '../src/services/issues.schema.js';
import { buildProfile, githubAccessFromEnv, normalizeAreas, normalizeLanguage, normalizeLanguages, readGithubLanguages } from '../src/services/profile.service.js';
import { StoreService } from '../src/services/store.service.js';
import { ContributeTools } from '../src/modules/contribute/contribute.tools.js';
import type { GraphqlFn } from '../src/services/github.graphql.js';

const NOW = '2026-10-16T12:00:00.000Z';
const daysAgo = (n: number): string => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
const ctx = { logger: { info: () => undefined } } as never;
const toolsFor = (store: StoreService, access: () => { enabled: boolean } = () => ({ enabled: false })): ContributeTools => Object.assign(new ContributeTools(store), { access });

const GOOD_BODY = 'When I call parse() with an empty string it throws a TypeError: cannot read properties of undefined.\n\nSteps to reproduce:\n1. call parse("")\n\nExpected: it should return an empty list.';

function issue(n: number, over: Partial<OpenIssue> = {}): OpenIssue {
  return {
    number: n, title: `Issue number ${n} about parsing`, url: `https://x/${n}`, body: GOOD_BODY, labels: [], assignees: [], author: 'zed', authorAssociation: 'NONE',
    createdAt: daysAgo(40), updatedAt: daysAgo(10), commentCount: 0, comments: [], linkedPrs: [], ...over,
  };
}
const file = (issues: OpenIssue[]): Pick<IssuesFile, 'issues' | 'fetchedAt'> => ({ issues, fetchedAt: NOW });

describe('clarityOf', () => {
  it('rewards length, repro steps, error text and expected behaviour', () => {
    const c = clarityOf({ title: 'Parser crash', body: GOOD_BODY });
    expect(c.clearEnough).toBe(true);
    expect(c.signals).toEqual(expect.arrayContaining(['reproduction steps', 'error text', 'expected behaviour or acceptance hint']));
    expect(c.score).toBeGreaterThan(0.8);
  });
  it.each([['', false], ['short', false], ['x'.repeat(50), true]])('body %j clearEnough=%s', (body, expected) => {
    expect(clarityOf({ title: 'A decent title', body }).clearEnough).toBe(expected);
  });
});

describe('claimEvidence', () => {
  it('flags assignees, open linked PRs and recent claim-style comments, with evidence', () => {
    expect(claimEvidence(issue(1, { assignees: ['amy'] }), NOW)).toMatchObject({ claimed: true, evidence: ['assigned to amy'] });
    expect(claimEvidence(issue(2, { linkedPrs: [{ number: 9, state: 'OPEN', isDraft: true, willClose: true }] }), NOW).evidence[0]).toMatch(/open PR #9 \(draft\)/);
    const c = claimEvidence(issue(3, { comments: [{ author: 'bob', association: 'NONE', createdAt: daysAgo(5), body: "Hi! Can I take this? I'd like to work on it." }] }), NOW);
    expect(c.claimed).toBe(true);
    expect(c.evidence[0]).toMatch(/comment by bob reads like a claim \(5 days ago\)/);
  });
  it('ignores old claim comments and treats a merged linked PR as maybe fixed', () => {
    expect(claimEvidence(issue(4, { comments: [{ author: 'bob', association: 'NONE', createdAt: daysAgo(400), body: 'can I take this?' }] }), NOW).claimed).toBe(false);
    const fixed = claimEvidence(issue(5, { linkedPrs: [{ number: 7, state: 'MERGED', isDraft: false, willClose: true }] }), NOW);
    expect(fixed).toMatchObject({ claimed: false, maybeFixed: true });
  });
  it('says what it checked when nothing indicates a claim', () => {
    expect(claimEvidence(issue(6), NOW).evidence[0]).toMatch(/no assignee, no linked open PR/);
  });
});

describe('findCandidates hard filters and boosts', () => {
  const all = [
    issue(1), // passes
    issue(2, { assignees: ['amy'] }), // claimed
    issue(3, { updatedAt: daysAgo(CANDIDATES.staleAfterDays + 30) }), // stale
    issue(4, { labels: ['wontfix'] }), // blocked
    issue(5, { body: 'too short' }), // unclear
    issue(6, { linkedPrs: [{ number: 1, state: 'MERGED', isDraft: false, willClose: true }] }), // maybe fixed
    issue(7, { labels: ['good first issue'] }), // passes with a boost
    issue(8, { comments: [{ author: 'maint', association: 'MEMBER', createdAt: daysAgo(3), body: 'Contributions welcome on this one!' }] }), // passes, maintainer wants it
    issue(9, { labels: ['Question'] }), // blocked, case-insensitive
  ];
  const r = findCandidates(file(all), undefined);

  it('keeps only issues that pass every filter and counts what each filter removed', () => {
    expect(r.candidates.map((c) => c.number).sort((a, b) => a - b)).toEqual([1, 7, 8]);
    expect(r.excluded).toEqual({ claimed: 1, maybeFixed: 1, stale: 1, blocked: 2, unclear: 1 });
    expect(r.considered).toBe(9);
    expect(r.excludedExamples.find((e) => e.reason === 'stale')!.detail).toMatch(/no activity for \d+ days/);
  });

  it('shows why each passed and the evidence behind "likely unclaimed"', () => {
    const c = r.candidates.find((x) => x.number === 1)!;
    expect(c.claim.label).toBe('likely unclaimed');
    expect(c.claim.evidence.length).toBeGreaterThan(0);
    expect(c.reasonsPassed).toHaveLength(5);
    expect(c.reasonsPassed.join(' ')).toMatch(/not claimed.*active 10 days ago.*clear enough/s);
  });

  it('ranks boosted issues above plain ones', () => {
    const order = r.candidates.map((c) => c.number);
    expect(order.indexOf(7)).toBeLessThan(order.indexOf(1));
    expect(order.indexOf(8)).toBeLessThan(order.indexOf(1));
    expect(r.candidates.find((c) => c.number === 7)!.boosts.labels).toEqual(['good first issue']);
    expect(r.candidates.find((c) => c.number === 8)!.boosts).toMatchObject({ maintainerWanted: true });
  });

  it('respects the limit and is deterministic', () => {
    expect(findCandidates(file(all), undefined, 2).candidates).toHaveLength(2);
    expect(JSON.stringify(findCandidates(file(all), undefined))).toBe(JSON.stringify(r));
  });

  it('notes when the title mentions only languages the contributor did not list', () => {
    const rs = findCandidates(file([issue(1, { title: 'Rust panic when parsing config' })]), { languages: ['ts'], level: 'beginner', familiarAreas: [] });
    expect(rs.candidates[0].languageNote).toMatch(/rust.*not in your languages/);
    const ok = findCandidates(file([issue(1, { title: 'TypeScript types for parse' })]), { languages: ['ts'], level: 'beginner', familiarAreas: [] });
    expect(ok.candidates[0].languageNote).toBeUndefined();
  });

  it('freshness halves every half-life', () => {
    expect(freshnessOf(NOW, NOW).score).toBe(1);
    expect(freshnessOf(daysAgo(120), NOW).score).toBeCloseTo(0.5, 2);
    expect(daysBetween('bad', NOW)).toBe(0);
  });
});

describe('refreshIssues (live mode only)', () => {
  const issuesFile: IssuesFile = { schemaVersion: 1, repo: 'a/b', snapshotId: 'a__b@1234567', fetchedAt: daysAgo(30), labelsQueried: ['good first issue'], limits: [], issues: [issue(1)] };
  const node = (n: number) => ({ number: n, title: `fresh ${n}`, url: '', body: GOOD_BODY, createdAt: daysAgo(2), updatedAt: daysAgo(1), labels: { nodes: [] }, assignees: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, timelineItems: { nodes: [] } });
  const gql: GraphqlFn = async (_q, vars) => ({ repository: { issues: { nodes: vars.labels ? [node(10), node(11)] : [node(11), node(12)] } } });

  it('fetches, merges and then serves from the 10-minute cache', async () => {
    const state = newRefreshState();
    const t0 = Date.parse(NOW);
    const first = await refreshIssues('a/b', issuesFile, gql, state, t0);
    expect(first.source).toBe('live-refresh');
    expect(first.issues.map((i) => i.number)).toEqual([10, 11, 12]);
    expect(first.fetchedAt).toBe(NOW);
    const second = await refreshIssues('a/b', issuesFile, async () => { throw new Error('must not be called'); }, state, t0 + 5 * 60_000);
    expect(second.source).toBe('live-cache');
    const third = await refreshIssues('a/b', issuesFile, gql, state, t0 + 11 * 60_000);
    expect(third.source).toBe('live-refresh');
  });

  it('falls back to the precomputed file with an "as of" note on failure or when the hourly budget is spent', async () => {
    const failing = await refreshIssues('a/b', issuesFile, async () => { throw new Error('rate limited'); }, newRefreshState());
    expect(failing).toMatchObject({ source: 'snapshot-file', fetchedAt: issuesFile.fetchedAt });
    expect(failing.note).toMatch(/as of/);
    const state = newRefreshState();
    for (let i = 0; i < CANDIDATES.refreshCallsPerHour; i++) state.calls.push({ at: Date.parse(NOW) });
    const spent = await refreshIssues('a/b', issuesFile, gql, state, Date.parse(NOW));
    expect(spent.source).toBe('snapshot-file');
    expect(spent.note).toMatch(/budget used up/);
  });
});

describe('profile building', () => {
  it('normalizes language names and areas', () => {
    expect(normalizeLanguage('TypeScript')).toBe('ts');
    expect(normalizeLanguage('Golang')).toBe('go');
    expect(normalizeLanguage('C++')).toBe('cpp');
    expect(normalizeLanguage('Brainfuck')).toBeNull();
    expect(normalizeLanguages(['TypeScript', 'ts', 'Python', 'Klingon'])).toEqual({ languages: ['ts', 'py'], unknown: ['Klingon'] });
    expect(normalizeAreas(['Backend', 'testing', 'Docs', 'backend', 'weird'])).toEqual(['api', 'tests', 'docs', 'weird']);
  });

  it('builds a stated profile and states what it read', async () => {
    const r = await buildProfile({ languages: ['TypeScript', 'Klingon'], level: 'intermediate', familiarAreas: ['Backend'] });
    expect(r.profile).toEqual({ languages: ['ts'], level: 'intermediate', familiarAreas: ['api'] });
    expect(r.githubCalls).toBe(0);
    expect(r.readNotes.join(' ')).toMatch(/Stated by you.*Not recognised.*Klingon/s);
  });

  it('does not read GitHub in snapshot mode, and says so', async () => {
    const r = await buildProfile({ languages: ['py'], level: 'beginner', username: '@octocat' });
    expect(r.githubCalls).toBe(0);
    expect(r.profile.username).toBe('octocat');
    expect(r.readNotes.join(' ')).toMatch(/snapshot mode and makes no runtime GitHub calls/);
  });

  it('reads public languages with exactly one call in live mode and rejects bad usernames', async () => {
    let calls = 0;
    const gql: GraphqlFn = async () => {
      calls++;
      return { user: { repositories: { nodes: [{ primaryLanguage: { name: 'Go' } }, { primaryLanguage: { name: 'Go' } }, { primaryLanguage: { name: 'Python' } }, { primaryLanguage: null }] } } };
    };
    const r = await buildProfile({ languages: ['ts'], level: 'advanced', username: 'octocat' }, { enabled: true, gql });
    expect(calls).toBe(1);
    expect(r.githubCalls).toBe(1);
    expect(r.profile.languages).toEqual(['ts', 'go', 'py']);
    expect(r.readNotes.join(' ')).toMatch(/1 GraphQL call/);
    expect(await readGithubLanguages('x', gql)).toEqual(['Go', 'Python']);

    const bad = await buildProfile({ languages: ['ts'], level: 'advanced', username: 'not a user!' }, { enabled: true, gql });
    expect(bad.githubCalls).toBe(0);
    expect(calls).toBe(2); // only readGithubLanguages above, not the invalid username
    const failing = await buildProfile({ languages: ['ts'], level: 'advanced', username: 'octocat' }, { enabled: true, gql: async () => { throw new Error('boom'); } });
    expect(failing.profile.languages).toEqual(['ts']);
    expect(failing.readNotes.join(' ')).toMatch(/failed; continuing/);
  });

  it('only enables GitHub in live mode with a token', () => {
    expect(githubAccessFromEnv({ RUNTIME_MODE: 'snapshot', GITHUB_TOKEN: 'x' } as never).enabled).toBe(false);
    expect(githubAccessFromEnv({ RUNTIME_MODE: 'live' } as never).enabled).toBe(false);
    expect(githubAccessFromEnv({ RUNTIME_MODE: 'live', GITHUB_TOKEN: 'x' } as never).enabled).toBe(true);
  });
});

describe('contribute tools on shipped data', () => {
  let tmp: string;
  let store: StoreService;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repoatlas-contrib-'));
    for (const f of ['lukeautry__tsoa@f0f9aa7.json', 'lukeautry__tsoa@f0f9aa7.issues.json', 'sample.json']) fs.copyFileSync(path.join('data/snapshots', f), path.join(tmp, f));
    store = new StoreService();
    store.dir = tmp;
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('find_candidate_issues on real tsoa data: filtered, evidenced, dated', async () => {
    const tools = toolsFor(store);
    const r = (await tools.findCandidateIssues({ snapshotId: 'tsoa', limit: 10 }, ctx)) as unknown as {
      candidates: { number: number; claim: { label: string }; reasonsPassed: string[]; labels: string[] }[];
      excluded: Record<string, number>; considered: number; issuesAsOf: string; source: string; localizeNext: number[]; limits: { tier: number }; claimNote: string;
    };
    expect(r.source).toBe('snapshot-file');
    expect(r.issuesAsOf).toMatch(/^2026-10-16/);
    expect(r.considered).toBe(97);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.length).toBeLessThanOrEqual(10);
    for (const c of r.candidates) {
      expect(c.claim.label).toBe('likely unclaimed');
      expect(c.reasonsPassed).toHaveLength(5);
    }
    expect(Object.values(r.excluded).reduce((a, b) => a + b, 0) + r.candidates.length).toBeLessThanOrEqual(r.considered);
    expect(r.localizeNext).toEqual(r.candidates.slice(0, 5).map((c) => c.number));
    expect(r.limits.tier).toBe(2);
    expect(r.claimNote).toMatch(/off GitHub/);
  });

  it('refresh=true in snapshot mode explains why nothing was refreshed', async () => {
    const tools = toolsFor(store);
    const r = (await tools.findCandidateIssues({ snapshotId: 'tsoa', refresh: true }, ctx)) as unknown as { refreshNote: string; source: string };
    expect(r.source).toBe('snapshot-file');
    expect(r.refreshNote).toMatch(/snapshot mode/);
  });

  it('a snapshot without an issues file returns a clear note, not an error', async () => {
    const tools = toolsFor(store);
    const r = (await tools.findCandidateIssues({ snapshotId: 'sample' }, ctx)) as unknown as { candidates: unknown[]; note: string; issuesAsOf: null };
    expect(r.candidates).toEqual([]);
    expect(r.issuesAsOf).toBeNull();
    expect(r.note).toMatch(/does not fetch issues on demand/);
  });

  it('errors helpfully for an unknown snapshot, and profile_contributor works through the tool', async () => {
    const tools = toolsFor(store);
    await expect(tools.findCandidateIssues({ snapshotId: 'nope/nope' }, ctx)).rejects.toThrow(/Available snapshots/);
    const p = await tools.profileContributor({ languages: ['TypeScript'], level: 'beginner' }, ctx);
    expect(p.profile.languages).toEqual(['ts']);
    expect(p.next[0]).toMatch(/find_candidate_issues/);
  });
});
