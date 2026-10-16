import { describe, expect, it } from 'vitest';
import { StoreService } from '../src/services/store.service.js';
import { SnapshotSchema } from '../src/services/snapshot.schema.js';
import { GraphIndex } from '../src/services/graph.query.js';
import { FIRST_CHANGE } from '../src/config/weights.js';
import { clarityOf } from '../src/services/issues.service.js';
import { scoreFirstChange, sizeFitRaw } from '../src/services/firstchange.service.js';
import { LocalizeTools } from '../src/modules/contribute/localize.tools.js';
import type { OpenIssue } from '../src/services/issues.schema.js';
import type { Profile } from '../src/services/profile.types.js';

const ctx = { logger: { info: () => undefined } } as never;

interface F {
  path: string;
  meta?: Record<string, unknown>;
}

function build(files: F[], tier: 1 | 2 = 2, persons: { id: string; label: string; login?: string }[] = []): GraphIndex {
  const nodes: unknown[] = files.map((f) => ({ id: `file:${f.path}`, kind: 'file', label: f.path, meta: { path: f.path, lang: 'ts', loc: 100, centrality: 0, ...f.meta } }));
  for (const p of persons) nodes.push({ id: p.id, kind: 'person', label: p.label, meta: p.login ? { login: p.login } : {} });
  return new GraphIndex(SnapshotSchema.parse({ schemaVersion: 1, repo: 'demo/shop', sha: 'abcdef1', builtAt: '2026-10-01T00:00:00Z', tier, truncated: false, commitWindow: 100, nodes, edges: [] }));
}

const profile = (over: Partial<Profile> = {}): Profile => ({ languages: ['ts'], level: 'intermediate', familiarAreas: [], ...over });
const CLEAR_BODY = 'Steps to reproduce:\n1. call parse\nExpected: it should return an object.\nError: TypeError cannot read property x of undefined.\n```ts\nparse(x)\n```\nThis is a detailed report with enough text to be useful to anyone.';
const issue = { title: 'Parse crashes on empty input', body: CLEAR_BODY };
const factorOf = (r: ReturnType<typeof scoreFirstChange>, name: string) => r.factors.find((f) => f.name === name)!;

describe('factors', () => {
  const files: F[] = [
    { path: 'src/a.ts', meta: { lang: 'ts', centrality: 0.2, testedBy: ['tests/a.spec.ts'] } },
    { path: 'src/b.js', meta: { lang: 'js', centrality: 0.4 } },
  ];
  const idx = build(files);

  it('computes every factor from the formula', () => {
    const r = scoreFirstChange(idx, { ...issue, updatedAt: '2026-06-01T00:00:00Z' }, profile({ level: 'beginner' }), {
      files: ['src/a.ts', 'src/b.js'],
      issuesFetchedAt: new Date(Date.parse('2026-06-01T00:00:00Z') + FIRST_CHANGE.freshnessHalfLifeDays * 86_400_000).toISOString(),
    });
    expect(r.factors.map((f) => f.name)).toEqual(['languageFit', 'centrality', 'testPresence', 'freshness', 'clarity', 'sizeFit']);
    expect(factorOf(r, 'languageFit').raw).toBe(0.8); // ts = 1, js = 0.6 partial credit
    expect(factorOf(r, 'centrality').raw).toBe(0.7); // 1 - mean(0.2, 0.4)
    expect(factorOf(r, 'testPresence').raw).toBe(0.5); // one of two files has tests
    expect(factorOf(r, 'freshness').raw).toBe(0.5); // exactly one half-life old
    expect(factorOf(r, 'clarity').raw).toBe(clarityOf(issue).score);
    expect(factorOf(r, 'sizeFit').raw).toBe(1); // 2 files, beginner ideal is 2
    for (const f of r.factors) expect(f.explanation.length).toBeGreaterThan(10);
    const product = r.factors.reduce((a, f) => a * f.floored, 1);
    expect(r.score).toBeCloseTo(product, 3);
    expect(r.formula).toMatch(/languageFit x \(1 - centrality\) x testPresence x freshness x clarity x sizeFit/);
  });

  it('free text with no date has freshness 1.0', () => {
    const r = scoreFirstChange(idx, issue, profile(), { files: ['src/a.ts'] });
    expect(factorOf(r, 'freshness').raw).toBe(1);
  });

  it('language fit: case-insensitive, ts/js partial credit only when the pair is missing', () => {
    const only = (languages: string[]) => factorOf(scoreFirstChange(idx, issue, profile({ languages }), { files: ['src/a.ts', 'src/b.js'] }), 'languageFit').raw;
    expect(only(['TS'])).toBe(0.8);
    expect(only(['js'])).toBe(0.8);
    expect(only(['ts', 'js'])).toBe(1);
    expect(only(['go'])).toBe(0);
  });

  it('prose files are language-neutral', () => {
    const i = build([{ path: 'docs/guide.md', meta: { lang: 'markdown' } }]);
    expect(factorOf(scoreFirstChange(i, issue, profile({ languages: ['go'] }), { files: ['docs/guide.md'] }), 'languageFit').raw).toBe(1);
  });
});

describe('floor', () => {
  it('a factor of 0 never zeroes the score; the score is the product of floored factors', () => {
    const idx = build([{ path: 'src/x.rs', meta: { lang: 'rust', centrality: 1 } }]);
    const r = scoreFirstChange(idx, { title: 'x', body: '' }, profile(), { files: ['src/x.rs'] });
    const floor = FIRST_CHANGE.factorFloor;
    expect(factorOf(r, 'languageFit')).toMatchObject({ raw: 0, floored: floor });
    expect(factorOf(r, 'centrality')).toMatchObject({ raw: 0, floored: floor });
    expect(factorOf(r, 'testPresence')).toMatchObject({ raw: 0, floored: floor });
    expect(factorOf(r, 'clarity')).toMatchObject({ raw: 0, floored: floor });
    for (const f of r.factors) expect(f.floored).toBeGreaterThanOrEqual(floor);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeCloseTo(Math.max(0.001, r.factors.reduce((a, f) => a * f.floored, 1)), 3);
  });
});

describe('size fit by level', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ path: `src/f${i}.ts`, meta: { testedBy: ['t.spec.ts'] } }));
  const idx = build(six);
  const paths = six.map((f) => f.path);

  it('sizeFitRaw is 1 to ideal, linear down, floor at hard max', () => {
    const [, ideal, hard] = FIRST_CHANGE.sizeByLevel.beginner;
    expect(sizeFitRaw(1, 'beginner')).toBe(1);
    expect(sizeFitRaw(ideal, 'beginner')).toBe(1);
    expect(sizeFitRaw(hard, 'beginner')).toBeCloseTo(FIRST_CHANGE.factorFloor, 10);
    expect(sizeFitRaw(ideal + 1, 'beginner')).toBeLessThan(1);
    expect(sizeFitRaw(ideal + 1, 'beginner')).toBeGreaterThan(sizeFitRaw(ideal + 2, 'beginner'));
  });

  it('the same six files fit an advanced contributor better than a beginner', () => {
    const beginner = scoreFirstChange(idx, issue, profile({ level: 'beginner' }), { files: paths });
    const advanced = scoreFirstChange(idx, issue, profile({ level: 'advanced' }), { files: paths });
    expect(factorOf(beginner, 'sizeFit').floored).toBe(FIRST_CHANGE.factorFloor);
    expect(factorOf(advanced, 'sizeFit').raw).toBe(1);
    expect(advanced.score).toBeGreaterThan(beginner.score);
    expect(beginner.estimatedFileCount).toBe(6);
  });

  it('counts only files scoring at least half of the top one when localizing', () => {
    const files: F[] = [
      { path: 'src/schemaParser.ts', meta: { exports: ['parseSchema', 'SchemaParser'] } },
      { path: 'src/schemaLoader.ts', meta: { exports: ['loadSchema'] } },
      ...Array.from({ length: 4 }, (_, i) => ({ path: `src/misc${i}.ts` })),
    ];
    const r = scoreFirstChange(build(files), { title: 'Schema parser crashes on nested objects', body: 'parseSchema throws' }, profile({ level: 'beginner' }));
    expect(r.files[0].path).toBe('src/schemaParser.ts');
    expect(r.estimatedFileCount).toBeGreaterThanOrEqual(1);
    expect(r.estimatedFileCount).toBeLessThanOrEqual(r.files.length);
  });
});

describe('narrative fields', () => {
  it('labels effort as an estimate and adds watch-outs for untested, central and unclear', () => {
    const idx = build(
      [
        { path: 'src/core.ts', meta: { centrality: 0.9, fanIn: 14, loc: 900, owners: ['person:a'] } },
        { path: 'src/ok.ts', meta: { testedBy: ['t.spec.ts'], owners: ['person:me'] } },
      ],
      2,
      [
        { id: 'person:a', label: 'Ann', login: 'ann' },
        { id: 'person:me', label: 'Me', login: 'me' },
      ],
    );
    const r = scoreFirstChange(idx, { title: 'Fix it', body: 'broken' }, profile({ username: 'ME' }), { files: ['src/core.ts', 'src/ok.ts'] });
    expect(r.estimatedEffort).toMatch(/^Estimate only/);
    expect(r.watchOuts).toContain('touches src/core.ts which has no tests');
    expect(r.watchOuts.join('\n')).toMatch(/central file src\/core\.ts \(imported by 14 files\)/);
    expect(r.watchOuts.join('\n')).toMatch(/issue is unclear: no reproduction steps/);
    expect(r.watchOuts.join('\n')).toMatch(/src\/core\.ts is large \(900 lines\)/);
    expect(r.whoToAsk).toEqual(['ann']); // the contributor is not told to ask themselves
    expect(r.whyItFits.split('. ').length).toBeGreaterThanOrEqual(2);
    expect(r.claim).toBeNull();
  });

  it('tier 1 adds a no-import-data watch-out; unknown supplied files are reported', () => {
    const r = scoreFirstChange(build([{ path: 'a.go', meta: { lang: 'go' } }], 1), issue, profile({ languages: ['go'] }), { files: ['a.go', 'missing.go'] });
    expect(r.watchOuts.join('\n')).toMatch(/snapshot is tier 1: no import data/);
    expect(r.unknownFiles).toEqual(['missing.go']);
    expect(r.notes.join(' ')).toMatch(/not in this snapshot/);
  });

  it('no localized files still returns a bounded score and a low-confidence watch-out', () => {
    const r = scoreFirstChange(build([{ path: 'a.ts' }]), { title: 'zebra quantum xylophone', body: '' }, profile());
    expect(r.files).toEqual([]);
    expect(r.confidence).toBe('low');
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.watchOuts.join(' ')).toMatch(/confidence is low/);
  });

  it('claim evidence comes from the issues file and adds a watch-out when claimed', () => {
    const open: OpenIssue = {
      number: 4,
      title: issue.title,
      url: 'https://github.com/o/r/issues/4',
      body: issue.body,
      labels: [],
      assignees: ['bob'],
      author: null,
      authorAssociation: 'NONE',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-20T00:00:00Z',
      commentCount: 0,
      comments: [],
      linkedPrs: [],
    };
    const r = scoreFirstChange(build([{ path: 'a.ts' }]), { ...issue, number: 4, updatedAt: open.updatedAt }, profile(), { files: ['a.ts'], openIssue: open, issuesFetchedAt: '2026-10-01T00:00:00Z' });
    expect(r.claim).toMatchObject({ claimed: true, asOf: '2026-10-01T00:00:00Z' });
    expect(r.watchOuts.join(' ')).toMatch(/may already be claimed: assigned to bob/);
  });
});

describe('score_first_change on real snapshots', () => {
  const store = new StoreService();
  store.dir = 'data/snapshots';
  const tools = new LocalizeTools(store);
  const p = { languages: ['ts'], level: 'beginner' as const, familiarAreas: ['tests'] };

  it('tsoa: three real open issues score within 0..1 over real files', async () => {
    const issues = await store.loadIssues('tsoa');
    const idx = new GraphIndex(await store.load('tsoa'));
    let nonEmpty = 0;
    for (const o of issues!.issues.slice(0, 3)) {
      const r = await tools.scoreFirstChange({ snapshotId: 'tsoa', issueNumber: o.number, profile: p }, ctx);
      expect(r.issuesAsOf).toBe(issues!.fetchedAt);
      expect(r.claim?.asOf).toBe(issues!.fetchedAt);
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.factors).toHaveLength(6);
      for (const f of r.factors) {
        expect(f.raw).toBeGreaterThanOrEqual(0);
        expect(f.raw).toBeLessThanOrEqual(1);
        expect(f.floored).toBeGreaterThanOrEqual(FIRST_CHANGE.factorFloor);
      }
      if (r.files.length) nonEmpty++;
      for (const f of r.files) {
        expect(idx.files.has(f.path)).toBe(true);
        for (const v of Object.values(f.components)) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
      expect(r.estimatedEffort).toMatch(/Estimate/);
      expect(JSON.stringify(r)).not.toMatch(/[\w.-]+@[\w-]+\.[a-z]{2,}/i);
    }
    expect(nonEmpty).toBeGreaterThan(0);
  });

  it('tsoa: explicit files bypass localization', async () => {
    const r = await tools.scoreFirstChange({ snapshotId: 'tsoa', title: 'Improve the CLI', body: '', profile: p, files: ['packages/cli/src/cli.ts'] }, ctx);
    expect(r.files.map((f) => f.path)).toEqual(['packages/cli/src/cli.ts']);
    expect(r.issuesAsOf).toBeNull();
  });

  it('tsoa: unknown issue number is an error', async () => {
    await expect(tools.scoreFirstChange({ snapshotId: 'tsoa', issueNumber: 987654, profile: p }, ctx)).rejects.toThrow(/not among/);
  });

  it('go-git (tier 1) scores without throwing and mentions tier 1', async () => {
    const r = await tools.scoreFirstChange({ snapshotId: 'go-git', title: 'Fetch fails with shallow clone', body: 'When fetching with depth 1 the packfile negotiation errors', profile: { languages: ['go'], level: 'intermediate', familiarAreas: [] } }, ctx);
    expect(r.limits.tier).toBe(1);
    expect(r.files.length).toBeGreaterThan(0);
    expect(r.files.every((f) => f.components.graphProximity === 0)).toBe(true);
    expect(r.score).toBeGreaterThan(0);
    expect(r.watchOuts.join(' ')).toMatch(/tier 1/);
  });
});
