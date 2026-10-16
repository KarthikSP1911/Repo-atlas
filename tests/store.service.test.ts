import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_SNAPSHOT_BYTES,
  SnapshotError,
  SnapshotSchema,
  StoreService,
  normalizeRepoRef,
  parseSnapshotId,
  repoKey,
  snapshotId,
  summarize,
  type Snapshot,
} from '../src/services/store.service.js';
import { GraphResources, snapshotIdFromSummaryUri } from '../src/modules/graph/graph.resources.js';

const SAMPLE_ID = 'demo__sample-shop@5a3f0c1';
const shipped = (): Snapshot => JSON.parse(fs.readFileSync('data/snapshots/sample.json', 'utf8')) as Snapshot;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

let tmp: string;
let sampleDir: string; // a directory holding only the sample, so tests do not depend on other shipped snapshots
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repoatlas-store-'));
  sampleDir = path.join(tmp, 'sample-only');
  fs.mkdirSync(sampleDir);
  fs.copyFileSync('data/snapshots/sample.json', path.join(sampleDir, 'sample.json'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function storeFor(files: Record<string, unknown | string>): StoreService {
  const dir = fs.mkdtempSync(path.join(tmp, 'd-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  const s = new StoreService();
  s.dir = dir;
  return s;
}

function withSha(sha: string, repo = 'demo/sample-shop', builtAt?: string): Snapshot {
  const s = shipped();
  s.sha = sha;
  s.repo = repo;
  if (builtAt) s.builtAt = builtAt;
  return s;
}

describe('shipped sample snapshot', () => {
  it('validates and has the expected shape', () => {
    const snap = SnapshotSchema.parse(shipped());
    expect(snap.nodes).toHaveLength(40);
    expect(snap.edges).toHaveLength(80);
    expect(snap.tier).toBe(2);
    expect(fs.statSync('data/snapshots/sample.json').size).toBeLessThan(MAX_SNAPSHOT_BYTES);
  });

  it('loads by alias, id, owner/repo, owner__repo and GitHub URL', async () => {
    const store = new StoreService();
    store.dir = sampleDir;
    for (const ref of [
      'sample',
      SAMPLE_ID,
      'demo/sample-shop',
      'DEMO/Sample-Shop',
      'demo__sample-shop',
      'https://github.com/demo/sample-shop',
      'https://github.com/demo/sample-shop.git',
      'github.com/demo/sample-shop/tree/main/src?x=1',
    ]) {
      const snap = await store.load(ref);
      expect(snapshotId(snap.repo, snap.sha), ref).toBe(SAMPLE_ID);
    }
    expect((await store.list()).map((i) => i.id)).toEqual([SAMPLE_ID]);
  });
});

describe('validation', () => {
  const bad: [string, (s: Snapshot) => void, RegExp][] = [
    ['duplicate node id', (s) => s.nodes.push(clone(s.nodes[0])), /duplicate node id/],
    ['dangling edge target', (s) => s.edges.push({ from: 'file:src/index.ts', to: 'file:nope.ts', kind: 'imports' }), /unknown node/],
    ['wrong endpoint kinds', (s) => s.edges.push({ from: 'person:alice', to: 'file:src/index.ts', kind: 'imports' }), /may not connect/],
    ['fixes edge without confidence', (s) => s.edges.push({ from: 'pr:12', to: 'issue:8', kind: 'fixes' }), /needs a confidence/],
    ['id prefix does not match kind', (s) => { s.nodes[0].id = 'file:oops'; }, /must start with/],
    ['file node without meta.path', (s) => { s.nodes.find((n) => n.kind === 'file')!.meta = {}; }, /needs meta.path/],
    ['bad repo name', (s) => { s.repo = 'not a repo'; }, /owner\/name/],
    ['bad sha', (s) => { s.sha = 'XYZ'; }, /hex/],
    ['wrong schema version', (s) => { (s as { schemaVersion: number }).schemaVersion = 2; }, /schemaVersion/],
    ['bad tier', (s) => { (s as { tier: number }).tier = 3; }, /tier/],
  ];
  it.each(bad)('rejects: %s', async (_name, mutate, pattern) => {
    const snap = shipped();
    mutate(snap);
    const parsed = SnapshotSchema.safeParse(snap);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.success ? [] : parsed.error.issues)).toMatch(pattern);

    const store = storeFor({ 'broken.json': snap });
    expect(await store.list()).toEqual([]);
    const problems = await store.problems();
    expect(problems).toHaveLength(1);
    expect(problems[0].file).toBe('broken.json');
    expect(problems[0].reason).toMatch(/failed validation/);
  });

  it('reports invalid JSON, oversized files, duplicates, and ignores *.issues.json and non-json', async () => {
    const big = JSON.stringify({ pad: ' '.repeat(MAX_SNAPSHOT_BYTES + 10) });
    const store = storeFor({
      'good.json': withSha('aaaaaaa1'),
      'copy-of-good.json': withSha('aaaaaaa1'),
      'garbage.json': '{not json',
      'huge.json': big,
      'good.issues.json': { anything: true },
      'notes.txt': 'hello',
    });
    expect((await store.list()).map((i) => i.id)).toEqual(['demo__sample-shop@aaaaaaa']);
    const reasons = Object.fromEntries((await store.problems()).map((p) => [p.file, p.reason]));
    expect(reasons['garbage.json']).toMatch(/not valid JSON/);
    expect(reasons['huge.json']).toMatch(/limit is 3 MB/);
    expect(Object.values(reasons).some((r) => /duplicate/.test(r))).toBe(true); // files are scanned in name order; the later one is flagged
    expect(Object.keys(reasons)).not.toContain('good.issues.json');
    expect(Object.keys(reasons)).not.toContain('notes.txt');
  });

  it('treats a missing directory as "no snapshots" with a helpful error', async () => {
    const store = new StoreService();
    store.dir = path.join(tmp, 'does-not-exist');
    expect(await store.list()).toEqual([]);
    await expect(store.load('demo/sample-shop')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('ref resolution and errors', () => {
  const store = (): StoreService => storeFor({
    'a.json': withSha('1111111', 'acme/widgets', '2026-01-01T00:00:00Z'),
    'b.json': withSha('2222222', 'acme/widgets', '2026-02-01T00:00:00Z'),
    'c.json': withSha('3333333', 'other/thing'),
  });

  it('picks the newest snapshot for a repo', async () => {
    expect(await store().resolve('acme/widgets')).toBe('acme__widgets@2222222');
  });

  it('suggests the available sha when the sha is wrong', async () => {
    const err = await store().resolve('acme__widgets@9999999').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotError);
    expect((err as SnapshotError).code).toBe('not_found');
    expect((err as SnapshotError).message).toContain('use that id');
    expect((err as SnapshotError).message).toContain('acme__widgets@2222222');
  });

  it('lists available snapshots for an unknown repo and mentions snapshot mode', async () => {
    const err = (await store().resolve('github.com/nobody/nothing').catch((e: unknown) => e)) as SnapshotError;
    expect(err.code).toBe('not_found');
    expect(err.message).toMatch(/snapshot mode/);
    expect(err.available).toEqual(['acme__widgets@1111111', 'acme__widgets@2222222', 'other__thing@3333333']);
    expect(err.message).toContain('other__thing@3333333');
  });

  it.each(['', '   ', 'not a ref!', '../../etc/passwd', '..\\..\\secret', 'a/b/../../c@@'])('rejects or misses bad ref %j', async (ref) => {
    const err = (await store().resolve(ref).catch((e: unknown) => e)) as SnapshotError;
    expect(err).toBeInstanceOf(SnapshotError);
    expect(['bad_ref', 'not_found']).toContain(err.code);
    expect(err.message).not.toMatch(/[A-Za-z]:\\|\/tmp\//); // never leaks file system paths
  });
});

describe('LRU cache', () => {
  it('keeps the 3 most recently used snapshots', async () => {
    const files: Record<string, Snapshot> = {};
    for (const n of [1, 2, 3, 4]) files[`s${n}.json`] = withSha(`${n}`.repeat(7), 'acme/repo');
    const store = storeFor(files);
    const ids = ['acme__repo@1111111', 'acme__repo@2222222', 'acme__repo@3333333', 'acme__repo@4444444'];

    await store.load(ids[0]);
    await store.load(ids[1]);
    await store.load(ids[2]);
    expect(store.cachedIds()).toEqual(ids.slice(0, 3));

    await store.load(ids[0]); // touch: 0 becomes most recent
    expect(store.cachedIds()).toEqual([ids[1], ids[2], ids[0]]);

    await store.load(ids[3]); // evicts the least recent (1)
    expect(store.cachedIds()).toEqual([ids[2], ids[0], ids[3]]);
  });

  it('returns the same object for a cache hit and a fresh one after reset', async () => {
    const store = storeFor({ 'x.json': withSha('abcdef1') });
    const a = await store.load('demo/sample-shop');
    expect(await store.load('demo__sample-shop@abcdef1')).toBe(a);
    store.reset();
    expect(await store.load('demo/sample-shop')).not.toBe(a);
  });
});

describe('summary', () => {
  it('summarises the sample', async () => {
    const store = new StoreService();
    store.dir = sampleDir;
    const s = await store.summary('sample');
    expect(s.id).toBe(SAMPLE_ID);
    expect(s.uri).toBe('graph://demo__sample-shop@5a3f0c1/summary');
    expect(s.counts.nodes).toMatchObject({ dir: 8, file: 16, entry: 1, doc: 2, person: 3, commit: 4, pr: 3, issue: 3 });
    expect(s.counts.edges.imports).toBe(19);
    expect(s.counts.edges.contains).toBe(23);
    expect(s.languages).toMatchObject({ ts: 11, json: 2, markdown: 2 });
    expect(s.topDirs[0]).toEqual({ path: 'src', files: 9 });
    expect(s.entryPoints).toEqual(['src/index.ts']);
    expect(s.limits.join(' ')).toMatch(/Tier 2/);
    expect(s.limits.join(' ')).toMatch(/last 200 commits/);
    expect(s.limits.join(' ')).not.toMatch(/Truncated/);
  });

  it('states truncation and tier 1 limits', () => {
    const snap = shipped();
    snap.truncated = true;
    snap.tier = 1;
    const s = summarize(snap);
    expect(s.limits.join(' ')).toMatch(/Truncated/);
    expect(s.limits.join(' ')).toMatch(/Tier 1/);
    expect(s.tierMeaning).toMatch(/no import graph/);
  });
});

describe('snapshot id helpers', () => {
  it('round-trips ids', () => {
    expect(snapshotId('Owner-1/my_repo.js', 'ABCDEF1234'.toLowerCase())).toBe('Owner-1__my_repo.js@abcdef1');
    expect(parseSnapshotId('Owner-1__my_repo.js@abcdef1')).toEqual({ repo: 'Owner-1/my_repo.js', sha7: 'abcdef1' });
    expect(parseSnapshotId('a__b__c@1234567')).toEqual({ repo: 'a/b__c', sha7: '1234567' }); // owner has no "_", so first "__" splits
    expect(repoKey('a/b')).toBe('a__b');
  });

  it.each([
    ['facebook/react', 'facebook/react'],
    ['https://github.com/facebook/react', 'facebook/react'],
    ['http://www.github.com/facebook/react.git', 'facebook/react'],
    ['github.com/facebook/react/issues/1#x', 'facebook/react'],
    ['facebook__react', 'facebook/react'],
    ['react', null],
    ['', null],
    ['https://gitlab.com/', null],
  ])('normalizeRepoRef(%j) -> %j', (input, expected) => {
    expect(normalizeRepoRef(input)).toBe(expected);
  });

  it.each(['no-sha', 'a__b@12345', 'a__b@ZZZZZZZ', 'a/b@1234567'])('parseSnapshotId rejects %j', (id) => {
    expect(parseSnapshotId(id)).toBeNull();
  });
});

describe('graph summary resource', () => {
  const ctx = { logger: { info: () => undefined } } as never;
  const resources = (): GraphResources => {
    const store = new StoreService();
    store.dir = sampleDir;
    return new GraphResources(store);
  };

  it('parses summary URIs', () => {
    expect(snapshotIdFromSummaryUri('graph://demo__sample-shop@5a3f0c1/summary')).toBe(SAMPLE_ID);
    expect(snapshotIdFromSummaryUri('graph://demo__sample-shop@5a3f0c1d2e4b6789abcdef0123456789abcdef01/summary')).toBe(SAMPLE_ID);
    for (const bad of ['graph://demo/sample-shop@5a3f0c1/summary', 'graph://x@zzzzzzz/summary', 'http://x@1234567/summary', 'graph://x@1234567/other'])
      expect(snapshotIdFromSummaryUri(bad)).toBeNull();
  });

  it('returns the summary for a known snapshot', async () => {
    const s = (await resources().summary('graph://demo__sample-shop@5a3f0c1/summary', ctx)) as { id: string; counts: unknown };
    expect(s.id).toBe(SAMPLE_ID);
    expect(s.counts).toBeTruthy();
  });

  it('gives helpful errors for unknown snapshots and malformed URIs', async () => {
    await expect(resources().summary('graph://nobody__nothing@1234567/summary', ctx)).rejects.toThrow(/Available snapshots: demo__sample-shop@5a3f0c1/);
    await expect(resources().summary('graph://bad', ctx)).rejects.toThrow(/Expected graph:\/\/owner__repo@sha7\/summary/);
  });
});
