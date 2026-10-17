import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StoreService } from '../src/services/store.service.js';
import { indexFor } from '../src/services/graph.query.js';
import { folderRoles, overviewOf, runSteps } from '../src/services/overview.service.js';
import { GraphTools } from '../src/modules/graph/graph.tools.js';

const ctx = { logger: { info: () => undefined } } as never;
let tmp: string;
let sampleStore: StoreService;
let realStore: StoreService;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repoatlas-overview-'));
  fs.copyFileSync('data/snapshots/sample.json', path.join(tmp, 'sample.json'));
  sampleStore = new StoreService();
  sampleStore.dir = tmp;
  realStore = new StoreService();
  realStore.dir = 'data/snapshots';
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('overviewOf on real snapshots', () => {
  it('tsoa (JS/TS monorepo, yarn): name, package manager, workspaces, real scripts, monorepo folder', async () => {
    const o = overviewOf(indexFor(await realStore.load('tsoa')));
    expect(o).toMatchObject({ name: 'tsoa-monorepo', license: 'MIT', primaryLanguage: 'TypeScript', packageManager: 'yarn' });
    expect(o.workspaces).toContain('packages/*');
    expect(o.runSteps.map((s) => `${s.step}:${s.command}:${s.inferred}`)).toEqual(
      expect.arrayContaining(['install:yarn install:true', 'build:yarn build:false', 'test:yarn test:false']),
    );
    expect(o.folders.find((f) => f.path === 'packages')).toMatchObject({ role: 'monorepo packages' });
    expect(o.entryPoints.length).toBeGreaterThan(0);
    expect(o.counts.files).toBeGreaterThan(100);
  });

  it('pwndbg (Python, uv): inferred install and test steps, no invented scripts', async () => {
    const o = overviewOf(indexFor(await realStore.load('pwndbg')));
    expect(o.packageManager).toBe('uv');
    expect(o.runSteps).toEqual([
      expect.objectContaining({ step: 'install', command: 'uv sync', inferred: true }),
      expect.objectContaining({ step: 'test', command: 'uv run pytest', inferred: true }),
    ]);
    expect(o.evidence.join(' ')).toMatch(/2 of 2 run steps are conventional/);
  });

  it('go-git (Go, tier 1): go build/test, no entry points, folder role comes from code not tests', async () => {
    const idx = indexFor(await realStore.load('go-git'));
    const o = overviewOf(idx);
    expect(o.runSteps.map((s) => s.command)).toEqual(['go build ./...', 'go test ./...']);
    expect(o.entryPoints).toEqual([]);
    const plumbing = o.folders.find((f) => f.path === 'plumbing')!;
    expect(plumbing.role).not.toMatch(/automated tests/);
    expect(o.folders.find((f) => f.path === '_examples')!.role).toMatch(/example code/);
  });
});

describe('folderRoles and runSteps on the sample', () => {
  it('describes folders from names and tags', async () => {
    const idx = indexFor(await sampleStore.load('sample'));
    const f = folderRoles(idx);
    expect(f.find((x) => x.path === 'src')).toMatchObject({ role: 'main source code', files: 9 });
    expect(f.find((x) => x.path === 'tests')).toMatchObject({ role: 'automated tests', files: 2 });
    expect(f.find((x) => x.path === '.')!.role).toMatch(/repo root/);
  });

  it('gives npm install for a package.json repo and nothing invented otherwise', async () => {
    const idx = indexFor(await sampleStore.load('sample'));
    const steps = runSteps(idx);
    expect(steps[0]).toMatchObject({ step: 'install', command: 'npm install', inferred: true });
    expect(steps.every((s) => s.command.length > 0 && s.source.length > 0)).toBe(true);
  });
});

describe('build_graph and project_overview tools', () => {
  it('build_graph resolves ids, aliases, owner/repo, bare names and URLs to a ready snapshot', async () => {
    const tools = new GraphTools(realStore);
    for (const repo of ['lukeautry/tsoa', 'tsoa', 'https://github.com/lukeautry/tsoa', 'lukeautry__tsoa@f0f9aa7', 'LUKEAUTRY/TSOA']) {
      const r = (await tools.buildGraph({ repo }, ctx)) as unknown as { status: string; snapshotId: string; tier: number; limits: { notes: string[] }; available: unknown[] };
      expect(r.status, repo).toBe('ready');
      expect(r.snapshotId).toBe('lukeautry__tsoa@f0f9aa7');
      expect(r.tier).toBe(2);
      expect(r.limits.notes.join(' ')).toMatch(/last 1000 commits/);
      expect(r.available.length).toBe(4);
    }
  });

  // Live builds are switched off here so these tests never reach GitHub (tests/live-build.test.ts covers the on-demand path with fakes).
  const liveOff = async (fn: () => Promise<void>): Promise<void> => {
    const prev = process.env.LIVE_BUILDS;
    process.env.LIVE_BUILDS = 'off';
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.LIVE_BUILDS;
      else process.env.LIVE_BUILDS = prev;
    }
  };

  it('build_graph returns a clear message, not an error, for repos it does not have (live builds off)', async () => {
    await liveOff(async () => {
      const tools = new GraphTools(realStore);
      const r = (await tools.buildGraph({ repo: 'facebook/react' }, ctx)) as { status: string; message: string; available: { snapshotId: string }[]; snapshotId?: string };
      expect(r.status).toBe('unavailable');
      expect(r.snapshotId).toBeUndefined();
      expect(r.message).toMatch(/precomputed ahead of time/);
      expect(r.available.map((a) => a.snapshotId)).toContain('pwndbg__pwndbg@b5162e6');
      expect(r.available.at(-1)!.snapshotId).toBe('demo__sample-shop@5a3f0c1'); // the fixture is listed last
    });
  });

  it('build_graph on a server with no snapshots says so (live builds off)', async () => {
    await liveOff(async () => {
      const empty = new StoreService();
      empty.dir = path.join(tmp, 'nothing-here');
      const r = (await new GraphTools(empty).buildGraph({ repo: 'a/b' }, ctx)) as { status: string; nextSteps: string[] };
      expect(r.status).toBe('unavailable');
      expect(r.nextSteps.join(' ')).toMatch(/No snapshots are installed/);
    });
  });

  it('project_overview carries evidence and the limits note, and errors helpfully on a bad id', async () => {
    const tools = new GraphTools(realStore);
    const r = (await tools.projectOverview({ snapshotId: 'pwndbg' }, ctx)) as { repo: string; evidence: string[]; limits: { snapshotId: string; tier: number; truncated: boolean } };
    expect(r.repo).toBe('pwndbg/pwndbg');
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(r.limits).toMatchObject({ snapshotId: 'pwndbg__pwndbg@b5162e6', tier: 2, truncated: false });
    await expect(tools.projectOverview({ snapshotId: 'nobody/nothing' }, ctx)).rejects.toThrow(/Available snapshots/);
  });

  it('ping reports the secret as a boolean only', async () => {
    const tools = new GraphTools(realStore);
    process.env.EXPORT_SECRET = 'super-secret-value';
    process.env.GITHUB_TOKEN = 'ghp_super_secret_token_value';
    const r = await tools.ping({ echo: 'x' }, ctx);
    expect(r.exportSecretConfigured).toBe(true);
    expect(r.githubTokenConfigured).toBe(true);
    expect(r.liveBuilds).toBe(true);
    expect(JSON.stringify(r)).not.toContain('super-secret-value');
    expect(JSON.stringify(r)).not.toContain('super_secret_token');
    delete process.env.EXPORT_SECRET;
    delete process.env.GITHUB_TOKEN;
  });
});
