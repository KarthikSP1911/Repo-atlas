import { describe, expect, it } from 'vitest';
import { StoreService } from '../src/services/store.service.js';
import { SnapshotSchema } from '../src/services/snapshot.schema.js';
import { GraphIndex } from '../src/services/graph.query.js';
import { LOCALIZE } from '../src/config/weights.js';
import { cleanIssueText, localizeIssue, readingOrderOf, resolveIssue, tokenize } from '../src/services/localize.service.js';
import { LocalizeTools } from '../src/modules/contribute/localize.tools.js';
import type { IssuesFile } from '../src/services/issues.schema.js';

const ctx = { logger: { info: () => undefined } } as never;
const BUILT = '2026-10-01T00:00:00Z';

interface F {
  path: string;
  meta?: Record<string, unknown>;
}
interface Spec {
  tier?: 1 | 2;
  files: F[];
  imports?: [string, string, number?][];
  prs?: { number: number; title: string; files: string[]; fixes?: number[] }[];
  commits?: { sha: string; subject: string; files: string[] }[];
  issues?: { number: number; title: string }[];
  persons?: { id: string; label: string; login?: string }[];
}

function build(spec: Spec): GraphIndex {
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  for (const f of spec.files) nodes.push({ id: `file:${f.path}`, kind: 'file', label: f.path.split('/').pop(), meta: { path: f.path, lang: 'ts', loc: 100, centrality: 0.1, ...f.meta } });
  for (const p of spec.persons ?? []) nodes.push({ id: p.id, kind: 'person', label: p.label, meta: p.login ? { login: p.login } : {} });
  for (const i of spec.issues ?? []) nodes.push({ id: `issue:${i.number}`, kind: 'issue', label: i.title, meta: { number: i.number, state: 'closed' } });
  for (const [a, b, w] of spec.imports ?? []) edges.push({ from: `file:${a}`, to: `file:${b}`, kind: 'imports', weight: w ?? 1 });
  for (const pr of spec.prs ?? []) {
    nodes.push({ id: `pr:${pr.number}`, kind: 'pr', label: pr.title, meta: { number: pr.number, state: 'merged', mergedAt: '2026-06-01T00:00:00Z' } });
    for (const p of pr.files) edges.push({ from: `pr:${pr.number}`, to: `file:${p}`, kind: 'touches' });
    for (const n of pr.fixes ?? []) edges.push({ from: `pr:${pr.number}`, to: `issue:${n}`, kind: 'fixes', confidence: 'exact' });
  }
  for (const c of spec.commits ?? []) {
    nodes.push({ id: `commit:${c.sha}`, kind: 'commit', label: c.subject, meta: { date: '2026-06-01T00:00:00Z' } });
    for (const p of c.files) edges.push({ from: `commit:${c.sha}`, to: `file:${p}`, kind: 'touches' });
  }
  const snap = SnapshotSchema.parse({ schemaVersion: 1, repo: 'demo/widgets', sha: 'abcdef1', builtAt: BUILT, tier: spec.tier ?? 2, truncated: false, commitWindow: 200, nodes, edges });
  return new GraphIndex(snap);
}

const base: F[] = [
  { path: 'src/parser/schemaParser.ts', meta: { exports: ['parseSchema', 'SchemaParser'], doc: 'Parses JSON schema documents', lastChangedAt: '2026-09-20T00:00:00Z' } },
  { path: 'src/ui/button.ts', meta: { exports: ['Button'], doc: 'A clickable button', lastChangedAt: '2026-09-20T00:00:00Z' } },
  { path: 'src/net/client.ts', meta: { exports: ['HttpClient'], doc: 'HTTP client', lastChangedAt: '2026-09-20T00:00:00Z' } },
];

describe('text processing', () => {
  it('splits camelCase and paths, folds plurals, drops stop words and numbers', () => {
    expect(tokenize('parseSchemaFiles in src/net_client.ts 42')).toEqual(['parse', 'schema', 'file', 'src', 'net', 'client', 'ts']);
  });
  it('strips urls, emails, markdown and fence markers but keeps code identifiers', () => {
    const t = cleanIssueText('See https://x.io/a?b=1 mail me@x.com ```ts\nparseSchema()\n``` [link](http://y.z) **bold**');
    expect(t).not.toMatch(/https?:|@|```|\*\*|\]\(/);
    expect(t).toContain('parseSchema');
    expect(t).toContain('link');
  });
});

describe('localizeIssue scoring', () => {
  it('BM25 puts the file whose path and symbols match the issue first', () => {
    const r = localizeIssue(build({ files: base }), { title: 'Schema parser crashes on nested objects', body: 'parseSchema throws when the schema has nested objects' });
    expect(r.files[0].path).toBe('src/parser/schemaParser.ts');
    expect(r.files[0].components.textMatch).toBe(1);
    expect(r.files[0].evidence.join(' ')).toMatch(/matches terms: .*schema/);
    expect(r.files.find((f) => f.path === 'src/ui/button.ts')).toBeUndefined();
  });

  it('combines the components with the LOCALIZE weights', () => {
    const r = localizeIssue(build({ files: base }), { title: 'Schema parser crashes', body: '' });
    const f = r.files[0];
    const expected = LOCALIZE.a * f.components.textMatch + LOCALIZE.b * f.components.historySimilarity + LOCALIZE.c * f.components.graphProximity + LOCALIZE.d * f.components.recency;
    expect(f.score).toBeCloseTo(expected, 2);
    for (const v of Object.values(f.components)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('history similarity lifts a file touched by a PR with a similar title, and records the PR and issue', () => {
    const files = [...base, { path: 'src/core/engine.ts', meta: { exports: ['Engine'], lastChangedAt: '2026-09-20T00:00:00Z' } }];
    const idx = build({
      files,
      issues: [{ number: 7, title: 'Retries hammer the server' }],
      prs: [{ number: 12, title: 'Fix flaky retry backoff', files: ['src/core/engine.ts'], fixes: [7] }],
    });
    const r = localizeIssue(idx, { title: 'Retry backoff is flaky', body: 'the retry backoff sometimes does not wait' });
    const engine = r.files.find((f) => f.path === 'src/core/engine.ts')!;
    expect(engine).toBeDefined();
    expect(engine.components.textMatch).toBe(0);
    expect(engine.components.historySimilarity).toBeGreaterThan(0.5);
    expect(engine.relatedPrs).toEqual([12]);
    expect(engine.relatedIssues).toEqual([7]);
    expect(engine.evidence.join('\n')).toMatch(/PR #12 "Fix flaky retry backoff" touched it \(similarity 0\.\d\d\)/);
  });

  it('graph proximity credits import neighbours of the text match and is 0 on tier 1', () => {
    const imports: [string, string][] = [['src/parser/schemaParser.ts', 'src/net/client.ts']];
    const issue = { title: 'Schema parser crashes', body: '' };
    const t2 = localizeIssue(build({ files: base, imports }), issue);
    const neighbour = t2.files.find((f) => f.path === 'src/net/client.ts')!;
    expect(neighbour.components.graphProximity).toBeGreaterThan(0);
    expect(neighbour.evidence).toContain('imports/imported by src/parser/schemaParser.ts');

    const t1 = localizeIssue(build({ files: base, tier: 1 }), issue);
    expect(t1.files.every((f) => f.components.graphProximity === 0)).toBe(true);
    expect(t1.files.find((f) => f.path === 'src/net/client.ts')).toBeUndefined();
    expect(t1.confidenceReasons.join(' ')).toMatch(/tier 1/);
  });

  it('recency orders otherwise equal files and falls back to 0.5 when unknown', () => {
    const idx = build({
      files: [
        { path: 'src/a/gadget.ts', meta: { lastChangedAt: '2020-01-01T00:00:00Z' } },
        { path: 'src/b/gadget.ts', meta: { lastChangedAt: '2026-09-25T00:00:00Z' } },
        { path: 'src/c/gadget.ts', meta: {} },
      ],
    });
    const r = localizeIssue(idx, { title: 'gadget rendering is broken', body: '' });
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(r.files[0].path).toBe('src/b/gadget.ts');
    expect(by['src/b/gadget.ts'].components.recency).toBeGreaterThan(0.9);
    expect(by['src/a/gadget.ts'].components.recency).toBeLessThan(0.01);
    expect(by['src/c/gadget.ts'].components.recency).toBe(0.5);
  });

  it('is deterministic and breaks exact ties by path', () => {
    const idx = build({ files: [{ path: 'src/z/gadget.ts' }, { path: 'src/m/gadget.ts' }, { path: 'src/a/gadget.ts' }] });
    const issue = { title: 'gadget is broken', body: 'the gadget fails' };
    const a = localizeIssue(idx, issue);
    const b = localizeIssue(idx, issue);
    expect(a).toEqual(b);
    expect(a.files.map((f) => f.path)).toEqual(['src/a/gadget.ts', 'src/m/gadget.ts', 'src/z/gadget.ts']);
  });

  it('returns at most LOCALIZE.topFiles files', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ path: `src/m${i}/gadget.ts` }));
    expect(localizeIssue(build({ files }), { title: 'gadget broken', body: '' }).files).toHaveLength(LOCALIZE.topFiles);
  });

  it('excludes test files by default but shows them under tests; includeTests lets them compete', () => {
    const files: F[] = [
      { path: 'src/parser/schemaParser.ts', meta: { testedBy: ['tests/schemaParser.spec.ts'] } },
      { path: 'tests/schemaParser.spec.ts', meta: { isTest: true } },
      { path: 'schemaParser.test.ts' },
    ];
    const issue = { title: 'schema parser fails', body: '' };
    const r = localizeIssue(build({ files }), issue);
    expect(r.files.map((f) => f.path)).toEqual(['src/parser/schemaParser.ts']);
    expect(r.files[0].tests).toEqual(['tests/schemaParser.spec.ts']);
    const withTests = localizeIssue(build({ files }), issue, { includeTests: true });
    expect(withTests.files.map((f) => f.path)).toContain('tests/schemaParser.spec.ts');
  });

  it('excludes data-like files such as json and lockfiles', () => {
    const r = localizeIssue(build({ files: [{ path: 'data/schema.json' }, { path: 'yarn.lock' }, { path: 'src/schema.ts' }] }), { title: 'schema yarn problem', body: '' });
    expect(r.files.map((f) => f.path)).toEqual(['src/schema.ts']);
  });

  it('reading order puts dependencies before dependents even when the dependent scores higher', () => {
    const files: F[] = [
      { path: 'src/parser/schemaParser.ts', meta: { exports: ['parseSchema'] } },
      { path: 'src/net/client.ts' },
    ];
    const idx = build({ files, imports: [['src/parser/schemaParser.ts', 'src/net/client.ts']] });
    const r = localizeIssue(idx, { title: 'schema parser fails', body: '' });
    expect(r.files[0].path).toBe('src/parser/schemaParser.ts');
    expect(r.readingOrder).toEqual(['src/net/client.ts', 'src/parser/schemaParser.ts']);
  });

  it('readingOrderOf survives import cycles', () => {
    const idx = build({ files: [{ path: 'a.ts' }, { path: 'b.ts' }], imports: [['a.ts', 'b.ts'], ['b.ts', 'a.ts']] });
    expect(readingOrderOf(idx, [{ path: 'a.ts', score: 0.4 }, { path: 'b.ts', score: 0.9 }])).toEqual(['b.ts', 'a.ts']);
  });

  it('owner is a label without an email, even if a person label contains one', () => {
    const files: F[] = [{ path: 'src/parser/schemaParser.ts', meta: { owners: ['person:a'], exports: ['parseSchema'] } }];
    const withLogin = localizeIssue(build({ files, persons: [{ id: 'person:a', label: 'Ann', login: 'ann-dev' }] }), { title: 'schema parser fails', body: '' });
    expect(withLogin.files[0].owner).toBe('ann-dev');
    const leaky = localizeIssue(build({ files, persons: [{ id: 'person:a', label: 'ann@example.com' }] }), { title: 'schema parser fails', body: '' });
    expect(leaky.files[0].owner).not.toContain('@');
    expect(JSON.stringify(leaky)).not.toContain('@example.com');
  });
});

describe('localizeIssue confidence and edge cases', () => {
  it('empty or stop-word-only text gives low confidence, no files, no throw', () => {
    for (const issue of [{ title: '', body: '' }, { title: 'the and of', body: 'it is' }, { title: '   ', body: 'https://x.io' }]) {
      const r = localizeIssue(build({ files: base }), issue);
      expect(r.files).toEqual([]);
      expect(r.readingOrder).toEqual([]);
      expect(r.confidence).toBe('low');
      expect(r.confidenceReasons.length).toBeGreaterThan(0);
    }
  });

  it('text that matches nothing returns an empty list with a clear note', () => {
    const r = localizeIssue(build({ files: base }), { title: 'zebra quantum xylophone', body: '' });
    expect(r.files).toEqual([]);
    expect(r.confidence).toBe('low');
    expect(r.notes.join(' ')).toMatch(/No file/);
  });

  it('a very short query is low confidence even with a match', () => {
    const r = localizeIssue(build({ files: base }), { title: 'schema', body: '' });
    expect(r.files[0].path).toBe('src/parser/schemaParser.ts');
    expect(r.confidence).toBe('low');
  });

  it('echoes the issue flagged untrusted and never includes the body', () => {
    const r = localizeIssue(build({ files: base }), { title: 'Schema parser crashes', body: 'secret body text parseSchema', number: 5, labels: ['bug'], url: 'https://github.com/o/r/issues/5' });
    expect(r.issue).toEqual({ number: 5, title: 'Schema parser crashes', labels: ['bug'], url: 'https://github.com/o/r/issues/5', untrusted: true });
    expect(JSON.stringify(r)).not.toContain('secret body');
  });

  it('a clear, agreeing, well-separated result can reach high confidence', () => {
    const files: F[] = [
      { path: 'src/parser/schemaParser.ts', meta: { exports: ['parseSchema', 'SchemaParser'], lastChangedAt: '2026-09-25T00:00:00Z' } },
      { path: 'src/parser/nestedObjects.ts', meta: { lastChangedAt: '2026-09-25T00:00:00Z' } },
      ...Array.from({ length: 6 }, (_, i) => ({ path: `src/other/thing${i}.ts` })),
    ];
    const idx = build({ files, prs: [{ number: 3, title: 'Fix schema parser nested objects', files: ['src/parser/schemaParser.ts'] }] });
    const r = localizeIssue(idx, { title: 'Schema parser crashes on nested objects', body: 'parseSchema throws for nested objects in the schema parser' });
    expect(r.files[0].path).toBe('src/parser/schemaParser.ts');
    expect(['high', 'medium']).toContain(r.confidence);
    expect(r.confidenceReasons.join(' ')).toMatch(/agree/);
  });
});

describe('resolveIssue', () => {
  const file: IssuesFile = {
    schemaVersion: 1,
    repo: 'demo/widgets',
    snapshotId: 'demo__widgets@abcdef1',
    fetchedAt: '2026-10-02T00:00:00.000Z',
    labelsQueried: [],
    limits: [],
    issues: [10, 11, 12].map((n) => ({ number: n, title: `Issue ${n}`, url: `https://x/${n}`, body: 'body', labels: [], assignees: [], author: null, authorAssociation: 'NONE', createdAt: '2026-09-01T00:00:00Z', updatedAt: `2026-09-0${n - 9}T00:00:00Z`, commentCount: 0, comments: [], linkedPrs: [] })),
  };
  it('finds an issue by number', () => {
    expect(resolveIssue(file, { issueNumber: 11 }).open?.title).toBe('Issue 11');
  });
  it('unknown number is an error listing valid numbers', () => {
    expect(() => resolveIssue(file, { issueNumber: 999 })).toThrow(/#999 is not among.*#12/);
  });
  it('needs a number or text', () => {
    expect(() => resolveIssue(file, {})).toThrow(/issueNumber/);
    expect(() => resolveIssue(file, { title: '  ' })).toThrow(/issueNumber/);
  });
  it('free text works with or without an issues file; a number with no file needs text', () => {
    expect(resolveIssue(null, { title: 'Hello', body: 'World' }).issue).toEqual({ title: 'Hello', body: 'World' });
    expect(() => resolveIssue(null, { issueNumber: 3 })).toThrow(/no issues file/);
    expect(resolveIssue(null, { issueNumber: 3, title: 'T' }).notes[0]).toMatch(/no issues file/);
  });
});

describe('localize_issue on real snapshots', () => {
  const store = new StoreService();
  store.dir = 'data/snapshots';
  const tools = new LocalizeTools(store);

  it('tsoa: three real open issues localize to real files with sane components', async () => {
    const issues = await store.loadIssues('tsoa');
    expect(issues).not.toBeNull();
    const idx = new GraphIndex(await store.load('tsoa'));
    let nonEmpty = 0;
    for (const issue of issues!.issues.slice(0, 3)) {
      const r = await tools.localizeIssue({ snapshotId: 'tsoa', issueNumber: issue.number }, ctx);
      expect(r.issuesAsOf).toBe(issues!.fetchedAt);
      expect(r.limits.tier).toBe(2);
      expect(r.issue.number).toBe(issue.number);
      expect(r.files.length).toBeLessThanOrEqual(LOCALIZE.topFiles);
      if (r.files.length) nonEmpty++;
      for (const f of r.files) {
        expect(idx.files.has(f.path)).toBe(true);
        expect(f.score).toBeGreaterThanOrEqual(0);
        expect(f.score).toBeLessThanOrEqual(1);
        for (const v of Object.values(f.components)) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        expect(f.owner ?? '').not.toContain('@');
      }
      expect([...r.readingOrder].sort()).toEqual(r.files.map((f) => f.path).sort());
      expect(JSON.stringify(r)).not.toMatch(/[\w.-]+@[\w-]+\.[a-z]{2,}/i);
    }
    expect(nonEmpty).toBeGreaterThan(0);
  });

  it('tsoa: unknown issue number is a helpful error', async () => {
    await expect(tools.localizeIssue({ snapshotId: 'tsoa', issueNumber: 987654 }, ctx)).rejects.toThrow(/not among the \d+ open issues/);
  });

  it('go-git (tier 1) works on free text with graphProximity 0 and no issuesAsOf', async () => {
    const r = await tools.localizeIssue({ snapshotId: 'go-git', title: 'Fetch fails with shallow clone', body: 'When fetching with depth 1 the packfile negotiation errors' }, ctx);
    expect(r.limits.tier).toBe(1);
    expect(r.issuesAsOf).toBeNull();
    expect(r.files.length).toBeGreaterThan(0);
    expect(r.files.every((f) => f.components.graphProximity === 0)).toBe(true);
    expect(r.confidence).not.toBe('high');
  });

  it('the sample fixture has no issues file: a number needs free text', async () => {
    await expect(tools.localizeIssue({ snapshotId: 'sample', issueNumber: 1 }, ctx)).rejects.toThrow(/no issues file/);
  });
});
