import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StoreService, type Snapshot } from '../src/services/store.service.js';
import { indexFor, type GraphIndex } from '../src/services/graph.query.js';
import { explainFile, findEntryPoints, firstChain, normalizedEntries, roleOf, traceFlow } from '../src/services/flow.service.js';
import { AnalysisTools } from '../src/modules/graph/analysis.tools.js';
import { UNTRUSTED_NOTE } from '../src/services/tool.util.js';

const SAMPLE_ID = 'demo__sample-shop@5a3f0c1';
const ctx = { logger: { info: () => undefined } } as never;
let tmp: string;
const dirs: Record<string, string> = {};

const sampleSnap = (): Snapshot => JSON.parse(fs.readFileSync(path.join(dirs.sample, 'sample.json'), 'utf8')) as Snapshot;

function dirWith(name: string, file: string): string {
  const d = path.join(tmp, name);
  fs.mkdirSync(d);
  fs.copyFileSync(path.join('data/snapshots', file), path.join(d, file));
  return d;
}
function storeFor(name: string): StoreService {
  const s = new StoreService();
  s.dir = dirs[name];
  return s;
}
async function indexOf(name: string, ref: string): Promise<GraphIndex> {
  return indexFor(await storeFor(name).load(ref));
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repoatlas-flow-'));
  dirs.sample = dirWith('sample', 'sample.json');
  dirs.tsoa = dirWith('tsoa', 'lukeautry__tsoa@f0f9aa7.json');
  dirs.pwndbg = dirWith('pwndbg', 'pwndbg__pwndbg@b5162e6.json');
  dirs.gogit = dirWith('gogit', 'go-git__go-git@87e8ad5.json');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('find_entry_points', () => {
  it('resolves the sample entry to src/index.ts with its first chain', async () => {
    const idx = await indexOf('sample', 'sample');
    // the sample entry node has no meta.path; it is resolved through the starts edge
    expect(normalizedEntries(idx).map((e) => e.path)).toEqual(['src/index.ts']);
    const r = findEntryPoints(idx);
    expect(r.notice).toBeUndefined();
    expect(r.entryPoints).toHaveLength(1);
    const e = r.entryPoints[0];
    expect(e).toMatchObject({ path: 'src/index.ts', command: 'npm start' });
    // index imports server, config and logger with equal weight; logger is the most central
    expect(e.firstChain.map((s) => [s.path, s.depth])).toEqual([
      ['src/index.ts', 0],
      ['src/utils/logger.ts', 1],
    ]);
    expect(e.firstChain[1].via).toBe('imported by src/index.ts (weight 1)');
  });

  it('follows the heaviest import, then the most central, within depth 3 and 6 files', async () => {
    const snap = sampleSnap();
    snap.edges.find((x) => x.from === 'file:src/index.ts' && x.to === 'file:src/server.ts')!.weight = 5;
    const idx = indexFor(snap);
    const chain = firstChain(idx, 'src/index.ts');
    expect(chain.map((s) => s.path)).toEqual(['src/index.ts', 'src/server.ts', 'src/utils/logger.ts']);
    expect(chain.every((s) => s.depth <= 3)).toBe(true);
    expect(chain.length).toBeLessThanOrEqual(6);
    // from a route the chain can reach depth 3 and must never repeat a file
    const deep = firstChain(idx, 'src/routes/orders.ts');
    expect(new Set(deep.map((s) => s.path)).size).toBe(deep.length);
    expect(Math.max(...deep.map((s) => s.depth))).toBeLessThanOrEqual(3);
  });

  it('returns an explicit library notice and likely public files when there are no entries', async () => {
    const snap = sampleSnap();
    snap.nodes = snap.nodes.filter((n) => n.kind !== 'entry');
    snap.edges = snap.edges.filter((e) => e.kind !== 'starts');
    for (const n of snap.nodes) if (n.kind === 'file') n.meta.isEntry = false;
    const r = findEntryPoints(indexFor(snap));
    expect(r.entryPoints).toEqual([]);
    expect(r.notice).toMatch(/library/);
    expect(r.likelyPublicFiles![0]).toMatchObject({ path: 'src/index.ts', fanOut: 3 });
    expect(r.likelyPublicFiles![0].why).toMatch(/index/);
    expect(r.likelyPublicFiles!.length).toBeLessThanOrEqual(8);
  });

  it('go-git (tier 1) has no declared entries: library notice with top-level files', async () => {
    const r = findEntryPoints(await indexOf('gogit', 'go-git/go-git'));
    expect(r.entryPoints).toEqual([]);
    expect(r.notice).toMatch(/library/);
    expect(r.likelyPublicFiles!.length).toBeGreaterThan(0);
  });

  it('tsoa (tier 2): entries sorted by score, each starting its chain at the entry', async () => {
    const idx = await indexOf('tsoa', 'lukeautry/tsoa');
    const r = findEntryPoints(idx);
    expect(r.entryPoints.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < r.entryPoints.length; i++) expect(r.entryPoints[i - 1].score).toBeGreaterThanOrEqual(r.entryPoints[i].score);
    for (const e of r.entryPoints) {
      expect(idx.files.has(e.path)).toBe(true);
      expect(e.firstChain[0]).toMatchObject({ path: e.path, depth: 0 });
      expect(e.firstChain.length).toBeLessThanOrEqual(6);
    }
    expect(r.entryPoints.some((e) => e.firstChain.length > 1)).toBe(true);
  });
});

describe('trace_flow', () => {
  it('orders the sample breadth first, heaviest then most central then path, with no duplicates', async () => {
    const idx = await indexOf('sample', 'sample');
    const r = traceFlow(idx, idx.getFile('src/index.ts')!);
    expect(r.steps.map((s) => s.path)).toEqual([
      'src/index.ts',
      'src/utils/logger.ts', // depth 1: centrality 1
      'src/config.ts', // 0.75
      'src/server.ts', // 0.25
      'src/routes/orders.ts', // depth 2: tie on weight and centrality, path order
      'src/routes/users.ts',
      'src/services/user.service.ts', // depth 3: centrality 1 before 0.5
      'src/services/order.service.ts',
      'src/db/client.ts', // depth 4
    ]);
    expect(r.steps.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(r.steps.map((s) => s.depth)).toEqual([0, 1, 1, 1, 2, 2, 3, 3, 4]);
    expect(new Set(r.steps.map((s) => s.path)).size).toBe(r.steps.length);
    expect(r.truncated).toBe(false);
    expect(r.steps[0]).toMatchObject({ importedBy: null, depth: 0 });
    expect(r.steps[6]).toMatchObject({ importedBy: 'src/routes/orders.ts', why: 'imported by src/routes/orders.ts (weight 1)' });
    // edgesUsed: one tree edge per non-entry step
    expect(r.edgesUsed).toHaveLength(r.steps.length - 1);
    for (const e of r.edgesUsed) expect(idx.imports(e.from).some((l) => l.path === e.to && l.weight === e.weight)).toBe(true);
    expect(r.notice).toBeUndefined();
  });

  it('honours depth and maxFiles and reports why it stopped', async () => {
    const idx = await indexOf('sample', 'sample');
    const entry = idx.getFile('src/index.ts')!;
    const shallow = traceFlow(idx, entry, { depth: 2 });
    expect(Math.max(...shallow.steps.map((s) => s.depth))).toBe(2);
    expect(shallow).toMatchObject({ truncated: true, truncatedBy: 'depth' });
    expect(shallow.truncatedNote).toMatch(/depth=2/);
    const small = traceFlow(idx, entry, { maxFiles: 5 });
    expect(small.steps).toHaveLength(5);
    expect(small).toMatchObject({ truncated: true, truncatedBy: 'maxFiles' });
    const caps = traceFlow(idx, entry, { depth: 99, maxFiles: 999 });
    expect(caps.depth).toBe(6);
    expect(caps.maxFiles).toBe(40);
    const exact = traceFlow(idx, entry, { maxFiles: 9 });
    expect(exact.truncated).toBe(false);
  });

  it('returns only the entry plus a notice when a file imports nothing', async () => {
    const idx = await indexOf('sample', 'sample');
    const r = traceFlow(idx, idx.getFile('src/utils/logger.ts')!);
    expect(r.steps).toHaveLength(1);
    expect(r.isEntryPoint).toBe(false);
    expect(r.notice).toMatch(/imports no other file/);
  });

  it('tier 1 degrades to the entry with a no-import-graph notice', async () => {
    const idx = await indexOf('gogit', 'go-git/go-git');
    const file = [...idx.files.values()].find((f) => f.meta.lang === 'go' && !f.meta.isTest)!;
    const r = traceFlow(idx, file);
    expect(r.steps).toHaveLength(1);
    expect(r.notice).toMatch(/no import graph/);
  });

  it('tsoa (tier 2): traces from a real entry within caps', async () => {
    const idx = await indexOf('tsoa', 'lukeautry/tsoa');
    const entry = findEntryPoints(idx).entryPoints.find((e) => e.firstChain.length > 1)!;
    const r = traceFlow(idx, idx.getFile(entry.path)!, { depth: 3, maxFiles: 15 });
    expect(r.steps.length).toBeGreaterThan(1);
    expect(r.steps.length).toBeLessThanOrEqual(15);
    expect(new Set(r.steps.map((s) => s.path)).size).toBe(r.steps.length);
    expect(Math.max(...r.steps.map((s) => s.depth))).toBeLessThanOrEqual(3);
    expect(r.steps.every((s) => s.exports.length <= 8)).toBe(true);
    // depths never decrease: breadth first
    for (let i = 1; i < r.steps.length; i++) expect(r.steps[i].depth).toBeGreaterThanOrEqual(r.steps[i - 1].depth);
  });
});

describe('explain_file', () => {
  it('builds the dossier for order.service.ts from the sample', async () => {
    const idx = await indexOf('sample', 'sample');
    const d = explainFile(idx, idx.getFile('src/services/order.service.ts')!);
    expect(d.role).toBe('service or business logic');
    expect(d.metrics).toEqual({ loc: 210, fanIn: 2, fanOut: 3, centrality: 0.5, churn: 2, lastChangedAt: '2026-10-01T16:45:00Z' });
    expect(d.imports.map((i) => i.path)).toEqual(['src/db/client.ts', 'src/services/user.service.ts', 'src/utils/logger.ts']);
    expect(d.importedBy.map((i) => i.path).sort()).toEqual(['src/routes/orders.ts', 'tests/orders.test.ts']);
    expect(d.testedBy).toEqual(['tests/orders.test.ts']);
    expect(d.owners.map((o) => o.name)).toEqual(['alice', 'carol']);
    expect(JSON.stringify(d)).not.toContain('@');
    expect(d.recentCommits.map((c) => c.sha7)).toEqual(['f0a1b2c', 'c1a2b3d']);
    expect(d.recentCommits[0]).toMatchObject({ author: 'carol', date: '2026-10-01T16:45:00Z' });
    expect(d.mergedPrs.map((p) => p.number).sort()).toEqual([12, 21]);
    expect(d.docsMentioning).toEqual([{ doc: 'docs/architecture.md', title: 'Architecture notes', confidence: 'exact', via: 'names this file' }]);
    expect(d.confidence.level).toBe('high');
    expect(d.evidence.join(' ')).toMatch(/Imported by 2 files and imports 3 files/);
  });

  it('is low confidence for a file with no history, and for tier 1 or truncated snapshots', async () => {
    const idx = await indexOf('sample', 'sample');
    const d = explainFile(idx, idx.getFile('src/index.ts')!);
    expect(d.confidence.level).toBe('low');
    expect(d.confidence.reason).toMatch(/no history/);
    const tier1 = sampleSnap();
    tier1.tier = 1;
    tier1.truncated = true;
    const t = explainFile(indexFor(tier1), indexFor(tier1).getFile('src/services/order.service.ts')!);
    expect(t.confidence.level).toBe('low');
    expect(t.confidence.reason).toMatch(/Tier 1/);
    expect(t.confidence.reason).toMatch(/truncated/);
  });

  it('includes co-change partners and derived roles on tsoa', async () => {
    const idx = await indexOf('tsoa', 'lukeautry/tsoa');
    const d = explainFile(idx, idx.getFile('packages/cli/package.json')!);
    expect(d.changesWith.length).toBeGreaterThan(0);
    expect(d.changesWith[0].path).toBe('packages/tsoa/package.json');
    expect(d.changesWith[0].count).toBe(79);
    const util = idx.getFile('packages/cli/src/utils/importClassesFromDirectories.ts')!;
    const u = explainFile(idx, util);
    expect(u.role).toMatch(/shared helper/);
    expect(u.doc).toBe('Loads all exported classes from the given directory.');
    expect(u.exports).toEqual(['importClassesFromDirectories']);
    expect(u.owners.every((o) => !o.name.includes('@'))).toBe(true);
    expect(roleOf(idx.getFile('packages/cli/src/index.ts')!).role).toMatch(/entry point/);
  });

  it('pwndbg (python) and go-git (tier 1) give dossiers without throwing', async () => {
    const py = await indexOf('pwndbg', 'pwndbg/pwndbg');
    const d = explainFile(py, py.getFile('pwndbg/commands/config.py')!);
    expect(d.role).toMatch(/configuration/);
    expect(d.exports).toContain('display_config');
    expect(d.testedBy).toContain('tests/unit_tests/mocks/config.py');
    const go = await indexOf('gogit', 'go-git/go-git');
    const g = explainFile(go, [...go.files.values()].find((f) => f.meta.lang === 'go' && (f.meta.churn ?? 0) > 0)!);
    expect(g.confidence.level).toBe('low');
    expect(g.confidence.reason).toMatch(/Tier 1/);
    expect(g.imports).toEqual([]);
  });
});

describe('AnalysisTools', () => {
  const tools = (name = 'sample'): AnalysisTools => new AnalysisTools(storeFor(name));

  it('wraps every response with limits and the untrusted-text note', async () => {
    const t = tools();
    const results = [
      await t.findEntryPoints({ snapshotId: 'sample' }, ctx),
      await t.traceFlow({ snapshotId: SAMPLE_ID, entry: 'src/index.ts', depth: 2 }, ctx),
      await t.explainFile({ snapshotId: 'demo/sample-shop', path: 'src/server.ts' }, ctx),
    ];
    for (const r of results) {
      expect(r.limits).toMatchObject({ snapshotId: SAMPLE_ID, tier: 2, truncated: false, commitWindow: 200 });
      expect(r.limits.asOf).toBeTruthy();
      expect(r.note).toBe(UNTRUSTED_NOTE);
    }
  });

  it('trace_flow accepts loose paths and entry ids', async () => {
    const t = tools();
    expect((await t.traceFlow({ snapshotId: 'sample', entry: 'index.ts' }, ctx)).entry).toBe('src/index.ts');
    expect((await t.traceFlow({ snapshotId: 'sample', entry: 'entry:src/index.ts' }, ctx)).entry).toBe('src/index.ts');
    expect((await t.explainFile({ snapshotId: 'sample', path: 'order.service.ts' }, ctx)).path).toBe('src/services/order.service.ts');
  });

  it('suggests close paths when a path is wrong', async () => {
    const t = tools();
    await expect(t.explainFile({ snapshotId: 'sample', path: 'services/order.service' }, ctx)).rejects.toThrow(/Did you mean: src\/services\/order\.service\.ts/);
    await expect(t.traceFlow({ snapshotId: 'sample', entry: 'src/nope/zzz.ts' }, ctx)).rejects.toThrow(/No file "src\/nope\/zzz\.ts" in snapshot demo__sample-shop@5a3f0c1/);
    await expect(t.explainFile({ snapshotId: 'sample', path: 'totally/unknown.rs' }, ctx)).rejects.toThrow(/key_files or find_entry_points/);
  });

  it('gives a helpful error for a bad snapshot id on every tool', async () => {
    const t = tools();
    const bad = 'nobody/nothing';
    await expect(t.findEntryPoints({ snapshotId: bad }, ctx)).rejects.toThrow(/Available snapshots: demo__sample-shop@5a3f0c1/);
    await expect(t.keyFiles({ snapshotId: bad, role: 'new_dev' }, ctx)).rejects.toThrow(/Available snapshots/);
    await expect(t.traceFlow({ snapshotId: bad, entry: 'a.ts' }, ctx)).rejects.toThrow(/Available snapshots/);
    await expect(t.explainFile({ snapshotId: bad, path: 'a.ts' }, ctx)).rejects.toThrow(/Available snapshots/);
  });

  it('degrades with notices on go-git (tier 1)', async () => {
    const t = tools('gogit');
    const entries = await t.findEntryPoints({ snapshotId: 'go-git/go-git' }, ctx);
    expect(entries.notice).toMatch(/library/);
    expect(entries.limits.tier).toBe(1);
    const some = [...(await indexOf('gogit', 'go-git/go-git')).files.keys()].find((p) => p.endsWith('repository.go'))!;
    const trace = await t.traceFlow({ snapshotId: 'go-git/go-git', entry: some }, ctx);
    expect(trace.steps).toHaveLength(1);
    expect(trace.notice).toMatch(/no import graph/);
    const explain = await t.explainFile({ snapshotId: 'go-git/go-git', path: some }, ctx);
    expect(explain.confidence.level).toBe('low');
  });

  it('runs all four tools on tsoa (tier 2)', async () => {
    const t = tools('tsoa');
    const id = 'lukeautry/tsoa';
    const entries = await t.findEntryPoints({ snapshotId: id }, ctx);
    expect(entries.entryPoints.length).toBeGreaterThan(0);
    const key = await t.keyFiles({ snapshotId: id, role: 'new_dev' }, ctx);
    expect(key.tiers.mustRead.length).toBeGreaterThan(0);
    const start = entries.entryPoints.find((e) => e.firstChain.length > 1)!.path;
    const trace = await t.traceFlow({ snapshotId: id, entry: start }, ctx);
    expect(trace.steps.length).toBeGreaterThan(1);
    const explain = await t.explainFile({ snapshotId: id, path: key.tiers.mustRead[0].path }, ctx);
    expect(explain.confidence.level).toMatch(/high|medium|low/);
    expect(explain.limits.tier).toBe(2);
  });
});
