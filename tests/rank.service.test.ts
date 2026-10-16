import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StoreService } from '../src/services/store.service.js';
import { indexFor, type GraphIndex } from '../src/services/graph.query.js';
import { rankKeyFiles, scoreOf, testsCovering, type RankedItem } from '../src/services/rank.service.js';
import { ROLES } from '../src/services/tool.util.js';
import { AnalysisTools } from '../src/modules/graph/analysis.tools.js';

const SAMPLE_ID = 'demo__sample-shop@5a3f0c1';
const ctx = { logger: { info: () => undefined } } as never;
let tmp: string;
const dirs: Record<string, string> = {};

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
const all = (r: ReturnType<typeof rankKeyFiles>): RankedItem[] => [...r.tiers.mustRead, ...r.tiers.readNext];

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repoatlas-rank-'));
  dirs.sample = dirWith('sample', 'sample.json');
  dirs.tsoa = dirWith('tsoa', 'lukeautry__tsoa@f0f9aa7.json');
  dirs.gogit = dirWith('gogit', 'go-git__go-git@87e8ad5.json');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('rankKeyFiles on the sample', () => {
  it('follows the 10% / 25% tier rule over the 13 candidate files', async () => {
    const idx = await indexOf('sample', 'sample');
    const r = rankKeyFiles(idx, 'new_dev', 50);
    // candidates: 9 src files + package.json, tsconfig.json, .env.example, README.md; the 2 test files and docs/architecture.md are excluded
    expect(r.candidates).toBe(13);
    expect(r.tierSizes).toEqual({ mustRead: Math.ceil(1.3), readNext: Math.ceil(13 * 0.25), skipForNow: 13 - 2 - 4 });
    expect(r.tiers.mustRead.map((i) => i.path)).toEqual(['src/index.ts', 'src/config.ts']);
    expect(r.tiers.readNext).toHaveLength(4);
    expect(r.tiers.skipForNow.count).toBe(7);
    expect(r.tiers.skipForNow.examples.length).toBeLessThanOrEqual(10);
    const listed = [...r.tiers.mustRead, ...r.tiers.readNext].map((i) => i.path);
    expect(listed).not.toContain('tests/orders.test.ts');
    expect(listed).not.toContain('docs/architecture.md');
    expect(r.notes).toEqual([]);
  });

  it('components reproduce the formula for every item', async () => {
    const idx = await indexOf('sample', 'sample');
    const r = rankKeyFiles(idx, 'new_dev', 50);
    const maxFanIn = 4;
    const maxChurn = 2;
    const maxDocs = 1;
    for (const it of all(r)) {
      const f = idx.getFile(it.path)!;
      const c = it.components;
      expect(c.fanIn).toBe(f.meta.fanIn);
      expect(c.fanInHat).toBeCloseTo((f.meta.fanIn ?? 0) / maxFanIn, 3);
      expect(c.churnHat).toBeCloseTo((f.meta.churn ?? 0) / maxChurn, 3);
      expect(c.docsMentionsHat).toBeCloseTo((f.meta.docsMentions ?? 0) / maxDocs, 3);
      const expected = 3 * c.entry + 2 * c.fanInHat + 1.5 * c.config + 1 * c.churnHat + 1 * c.docsMentionsHat + 0.5 * c.tests;
      expect(Math.abs(it.score - expected)).toBeLessThan(0.0051);
      expect(Math.abs(it.score - scoreOf(c, r.weights))).toBeLessThan(0.0051);
    }
    const top = r.tiers.mustRead[0];
    expect(top).toMatchObject({ path: 'src/index.ts', tier: 'Must read', score: 4, reason: 'entry point; mentioned in docs' });
    expect(r.tiers.mustRead[1].reason).toBe('config file; imported by 3 files; changed 1 time');
  });

  it('orders by score desc then path, and is deterministic', async () => {
    const idx = await indexOf('sample', 'sample');
    const a = rankKeyFiles(idx, 'new_dev', 50);
    const b = rankKeyFiles(idx, 'new_dev', 50);
    expect(a).toEqual(b);
    const items = all(a);
    for (let i = 1; i < items.length; i++) {
      const [p, q] = [items[i - 1], items[i]];
      expect(p.score > q.score || (p.score === q.score && p.path.localeCompare(q.path) < 0)).toBe(true);
    }
  });

  it('limit caps items per tier but not the tier sizes', async () => {
    const idx = await indexOf('sample', 'sample');
    const r = rankKeyFiles(idx, 'new_dev', 1);
    expect(r.tiers.mustRead).toHaveLength(1);
    expect(r.tiers.readNext).toHaveLength(1);
    expect(r.tierSizes.readNext).toBe(4);
  });

  it('reviewer weights churn 1.5x', async () => {
    const idx = await indexOf('sample', 'sample');
    const base = rankKeyFiles(idx, 'new_dev', 50);
    const rev = rankKeyFiles(idx, 'reviewer', 50);
    expect(rev.weights.churn).toBe(1.5);
    expect(rev.roleAdjustments.join(' ')).toMatch(/1\.5x/);
    const order = (r: typeof base): RankedItem => all(r).find((i) => i.path === 'src/services/order.service.ts')!;
    expect(order(rev).score - order(base).score).toBeCloseTo(0.5, 2); // churnHat 1 * (1.5 - 1)
  });

  it('tester adds test files as candidates plus a bonus, and changes the order', async () => {
    const idx = await indexOf('sample', 'sample');
    const base = rankKeyFiles(idx, 'new_dev', 50);
    const tester = rankKeyFiles(idx, 'tester', 50);
    expect(tester.candidates).toBe(15);
    expect(tester.weights.testBonus).toBe(1);
    expect(tester.formula).toMatch(/testBearing/);
    const paths = [...all(tester).map((i) => i.path), ...tester.tiers.skipForNow.examples];
    expect(paths).toContain('tests/orders.test.ts');
    const order = all(tester).find((i) => i.path === 'src/services/order.service.ts')!;
    expect(order.components.tests).toBe(1); // derived from tests/orders.test.ts testFor
    expect(order.components.testBearing).toBe(1);
    expect(order.reason).toMatch(/has tests/);
    expect(all(tester).map((i) => i.path)).not.toEqual(all(base).map((i) => i.path));
    for (const it of all(tester)) {
      const c = it.components;
      expect(Math.abs(it.score - (3 * c.entry + 2 * c.fanInHat + 1.5 * c.config + c.churnHat + c.docsMentionsHat + 0.5 * c.tests + 1.0 * c.testBearing))).toBeLessThan(0.0051);
    }
  });

  it('quick_look returns only Must read, at most 5', async () => {
    const idx = await indexOf('sample', 'sample');
    const r = rankKeyFiles(idx, 'quick_look', 50);
    expect(r.tiers.mustRead.length).toBeGreaterThan(0);
    expect(r.tiers.mustRead.length).toBeLessThanOrEqual(5);
    expect(r.tiers.readNext).toEqual([]);
    expect(r.tiers.skipForNow.examples).toEqual([]);
    expect(r.tiers.mustRead.every((i) => i.tier === 'Must read')).toBe(true);
  });

  it('testsCovering merges testedBy and the inverse of testFor', async () => {
    const idx = await indexOf('sample', 'sample');
    expect(testsCovering(idx, 'src/services/order.service.ts')).toEqual(['tests/orders.test.ts']);
    expect(testsCovering(idx, 'src/server.ts')).toEqual([]);
  });
});

describe('key_files tool', () => {
  it('wraps the ranking with limits', async () => {
    const tools = new AnalysisTools(storeFor('sample'));
    const r = await tools.keyFiles({ snapshotId: 'sample', role: 'new_dev' }, ctx);
    expect(r.limits).toMatchObject({ snapshotId: SAMPLE_ID, tier: 2, truncated: false, commitWindow: 200 });
    expect(r.limits.asOf).toBeTruthy();
    expect(r.roleAdjustments.length).toBeGreaterThan(0);
  });

  it('gives a helpful error for a bad snapshot id', async () => {
    const tools = new AnalysisTools(storeFor('sample'));
    await expect(tools.keyFiles({ snapshotId: 'nobody/nothing', role: 'new_dev' }, ctx)).rejects.toThrow(/Available snapshots: demo__sample-shop@5a3f0c1/);
  });

  it.each(ROLES)('works for role %s', async (role) => {
    const tools = new AnalysisTools(storeFor('sample'));
    const r = await tools.keyFiles({ snapshotId: SAMPLE_ID, role }, ctx);
    expect(r.role).toBe(role);
    expect(r.tiers.mustRead.length).toBeGreaterThan(0);
  });
});

describe('key_files on real snapshots', () => {
  it('tsoa (tier 2): Must read is non-empty and holds an entry or a high fan-in file', async () => {
    const idx = await indexOf('tsoa', 'lukeautry/tsoa');
    for (const role of ROLES) {
      const r = rankKeyFiles(idx, role);
      expect(r.candidates).toBeGreaterThan(50);
      expect(r.tiers.mustRead.length).toBeGreaterThan(0);
      expect(r.tiers.mustRead.length).toBe(role === 'quick_look' ? 5 : Math.min(15, r.tierSizes.mustRead));
    }
    const r = rankKeyFiles(idx, 'new_dev');
    expect(r.tierSizes.mustRead).toBe(Math.ceil(r.candidates * 0.1));
    expect(r.tiers.mustRead.some((i) => i.components.entry === 1 || i.components.fanInHat >= 0.5)).toBe(true);
    expect(r.notes.join(' ')).not.toMatch(/Tier 1/);
  });

  it('go-git (tier 1): ranks without fan-in and says so', async () => {
    const idx = await indexOf('gogit', 'go-git/go-git');
    const r = rankKeyFiles(idx, 'new_dev');
    expect(r.tiers.mustRead.length).toBeGreaterThan(0);
    expect(all(r).every((i) => i.components.fanInHat === 0)).toBe(true);
    expect(r.notes.join(' ')).toMatch(/Tier 1/);
    expect(r.notes.join(' ')).toMatch(/no import graph/);
    const tools = new AnalysisTools(storeFor('gogit'));
    const viaTool = await tools.keyFiles({ snapshotId: 'go-git/go-git', role: 'tester', limit: 5 }, ctx);
    expect(viaTool.limits.tier).toBe(1);
    expect(viaTool.tiers.mustRead.length).toBeLessThanOrEqual(5);
  });
});
