import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GraphTools } from '../src/modules/graph/graph.tools.js';
import { AnalysisTools } from '../src/modules/graph/analysis.tools.js';
import { LiveBuildService } from '../src/services/live/live.service.js';
import { LiveRegistry, liveRegistry } from '../src/services/live/registry.js';
import { LiveBuildError } from '../src/services/live/fetch-tarball.js';
import { buildLiveSnapshot, type LiveBuildResult } from '../src/services/live/build-live.js';
import { StoreService } from '../src/services/store.service.js';
import { parseRepoSpec, type RepoSpec } from '../src/services/live/repo-spec.js';
import { fixtureFetch } from './helpers/live-fixture.js';

const ctx = { logger: { info: () => undefined } } as never;

let fixture: LiveBuildResult;
beforeAll(async () => {
  fixture = await buildLiveSnapshot(parseRepoSpec('acme/widgets')!, { fetchFn: fixtureFetch({ graphql: 'ok' }), token: 'tkn', now: () => new Date('2026-10-17T12:00:00Z') });
});

/** A build function that returns the fixture under the requested repo name. */
function fakeBuild(calls: string[] = [], delayMs = 0) {
  return async (spec: RepoSpec): Promise<LiveBuildResult> => {
    calls.push(spec.repo);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const snap = { ...fixture.snapshot, repo: spec.repo };
    return { ...fixture, snapshot: snap, issues: { ...fixture.issues, repo: spec.repo } };
  };
}

const memoryRegistry = (): LiveRegistry => {
  const r = new LiveRegistry();
  r.tmpDir = null;
  return r;
};

describe('LiveBuildService', () => {
  const prev = { ...process.env };
  afterEach(() => {
    process.env = { ...prev };
  });

  it('reuses a recent build instead of building again', async () => {
    const calls: string[] = [];
    const svc = new LiveBuildService({ build: fakeBuild(calls), registry: memoryRegistry() });
    const a = await svc.buildFor('acme/widgets');
    const b = await svc.buildFor('https://github.com/acme/widgets/tree/main');
    expect(calls).toEqual(['acme/widgets']);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
  });

  it('builds a repo once when several callers ask at the same time', async () => {
    const calls: string[] = [];
    const svc = new LiveBuildService({ build: fakeBuild(calls, 30), registry: memoryRegistry() });
    const [a, b, c] = await Promise.all([svc.buildFor('acme/widgets'), svc.buildFor('ACME/Widgets'), svc.buildFor('acme/widgets')]);
    expect(calls).toHaveLength(1);
    expect([a.cached, b.cached, c.cached].filter((x) => !x)).toHaveLength(1);
  });

  it('can be switched off', async () => {
    process.env.LIVE_BUILDS = 'off';
    const svc = new LiveBuildService({ build: fakeBuild(), registry: memoryRegistry() });
    expect(svc.enabled()).toBe(false);
    expect(svc.specOf('acme/widgets')).toBeNull();
    await expect(svc.buildFor('acme/widgets')).rejects.toMatchObject({ code: 'disabled' });
  });

  it('rejects things that are not a GitHub repo before doing any work', async () => {
    const calls: string[] = [];
    const svc = new LiveBuildService({ build: fakeBuild(calls), registry: memoryRegistry() });
    await expect(svc.buildFor('https://gitlab.com/a/b')).rejects.toMatchObject({ code: 'bad_ref' });
    await expect(svc.buildFor('a/b; rm -rf /')).rejects.toMatchObject({ code: 'bad_ref' });
    expect(calls).toEqual([]);
  });

  it('limits concurrent builds: a waiting build gets a clear "busy" message', async () => {
    const svc = new LiveBuildService({ build: fakeBuild([], 150), registry: memoryRegistry() });
    svc.maxConcurrent = 1;
    svc.waitMs = 30;
    const first = svc.buildFor('acme/one');
    await new Promise((r) => setTimeout(r, 5));
    await expect(svc.buildFor('acme/two')).rejects.toMatchObject({ code: 'busy', message: expect.stringMatching(/busy/) });
    await first;
    await expect(svc.buildFor('acme/three')).resolves.toBeDefined(); // the slot is free again
  });

  it('lets a waiting build start when a slot frees up in time', async () => {
    const calls: string[] = [];
    const svc = new LiveBuildService({ build: fakeBuild(calls, 40), registry: memoryRegistry() });
    svc.maxConcurrent = 1;
    svc.waitMs = 2000;
    await Promise.all([svc.buildFor('acme/one'), svc.buildFor('acme/two')]);
    expect(calls.sort()).toEqual(['acme/one', 'acme/two']);
  });

  it('caps new builds per hour, with the wait time in the message', async () => {
    const svc = new LiveBuildService({ build: fakeBuild(), registry: memoryRegistry() });
    svc.maxPerHour = 2;
    await svc.buildFor('acme/one');
    await svc.buildFor('acme/two');
    const err = (await svc.buildFor('acme/three').catch((e: unknown) => e)) as LiveBuildError;
    expect(err.code).toBe('rate_limited');
    expect(err.message).toMatch(/2 new repos in the last hour .* about \d+ minutes?/);
    await expect(svc.buildFor('acme/one')).resolves.toMatchObject({ cached: true }); // cached repos are still served
  });

  it('turns an unexpected failure into a generic message that leaks nothing', async () => {
    const svc = new LiveBuildService({
      build: async () => {
        throw new Error('ENOENT: /secret/path with token ghp_abc123');
      },
      registry: memoryRegistry(),
    });
    const err = (await svc.buildFor('acme/widgets').catch((e: unknown) => e)) as LiveBuildError;
    expect(err).toBeInstanceOf(LiveBuildError);
    expect(err.code).toBe('failed');
    expect(err.message).not.toMatch(/secret|ghp_|ENOENT/);
  });

  it('passes the server token to the build and never returns it', async () => {
    process.env.GITHUB_TOKEN = '  ghp_SERVER_TOKEN_123  ';
    let seen: string | undefined;
    const svc = new LiveBuildService({
      build: async (spec, o) => {
        seen = o.token;
        return fakeBuild()(spec);
      },
      registry: memoryRegistry(),
    });
    const r = await svc.buildFor('acme/widgets');
    expect(seen).toBe('ghp_SERVER_TOKEN_123');
    expect(JSON.stringify(r)).not.toContain('SERVER_TOKEN');
  });

  it('does not keep a failed build, so the next call tries again', async () => {
    let n = 0;
    const svc = new LiveBuildService({
      build: async (spec) => {
        if (n++ === 0) throw new LiveBuildError('upstream', 'GitHub hiccup');
        return fakeBuild()(spec);
      },
      registry: memoryRegistry(),
    });
    await expect(svc.buildFor('acme/widgets')).rejects.toMatchObject({ code: 'upstream' });
    await expect(svc.buildFor('acme/widgets')).resolves.toMatchObject({ cached: false });
  });
});

describe('LiveRegistry', () => {
  it('keeps the newest entries and expires old ones', async () => {
    const reg = memoryRegistry();
    reg.max = 2;
    const put = async (repo: string) => reg.put({ ...fixture.snapshot, repo }, { ...fixture.issues, repo });
    await put('a/one');
    await put('a/two');
    await put('a/three');
    expect(reg.list().map((e) => e.snapshot.repo)).toEqual(['a/three', 'a/two']);
    reg.ttlMs = -1;
    expect(reg.list()).toEqual([]);
  });
});

describe('live snapshots through the tools', () => {
  let store: StoreService;
  beforeEach(() => {
    liveRegistry.tmpDir = null;
    liveRegistry.clear();
    store = new StoreService();
    store.dir = 'data/snapshots';
  });
  afterEach(() => liveRegistry.clear());

  const graphTools = (calls: string[] = []) => {
    const t = new GraphTools(store);
    t.live = new LiveBuildService({ build: fakeBuild(calls), registry: liveRegistry });
    return t;
  };

  it('build_graph builds an unknown repo from a URL, labels it, and every other tool can then use it', async () => {
    const calls: string[] = [];
    const t = graphTools(calls);
    const r = (await t.buildGraph({ repo: 'https://github.com/acme/widgets' }, ctx)) as unknown as {
      status: string;
      source: string;
      snapshotId: string;
      tier: number;
      limits: { notes: string[] };
      available: { snapshotId: string }[];
    };
    expect(r.status).toBe('ready');
    expect(r.source).toBe('built_on_demand');
    expect(r.snapshotId).toBe('acme__widgets@bbbbbbb');
    expect(r.limits.notes.join(' ')).toMatch(/Built on demand from GitHub's archive/);
    expect(r.available.map((a) => a.snapshotId)).toContain('acme__widgets@bbbbbbb');

    const overview = (await t.projectOverview({ snapshotId: r.snapshotId }, ctx)) as { repo: string; limits: { notes: string[] } };
    expect(overview.repo).toBe('acme/widgets');
    expect(overview.limits.notes.join(' ')).toMatch(/approximate/);
    const keys = (await new AnalysisTools(store).keyFiles({ snapshotId: 'acme/widgets', role: 'new_dev' }, ctx)) as { limits: { snapshotId: string } };
    expect(keys.limits.snapshotId).toBe('acme__widgets@bbbbbbb'); // owner/repo resolves to the live snapshot too

    await t.buildGraph({ repo: 'acme/widgets' }, ctx);
    expect(calls).toEqual(['acme/widgets']); // the second call reused it
  });

  it('serves a precomputed repo without building anything', async () => {
    const calls: string[] = [];
    const r = (await graphTools(calls).buildGraph({ repo: 'lukeautry/tsoa' }, ctx)) as unknown as { status: string; source: string };
    expect(r).toMatchObject({ status: 'ready', source: 'precomputed' });
    expect(calls).toEqual([]);
  });

  it('returns an "unavailable" result with the reason, not an error, when a build fails', async () => {
    const t = new GraphTools(store);
    t.live = new LiveBuildService({
      build: async () => {
        throw new LiveBuildError('not_found', 'GitHub has no public repo acme/ghost. Check the spelling; private repos are not supported.');
      },
      registry: liveRegistry,
    });
    const r = (await t.buildGraph({ repo: 'acme/ghost' }, ctx)) as unknown as { status: string; message: string; snapshotId?: string; available: unknown[] };
    expect(r.status).toBe('unavailable');
    expect(r.snapshotId).toBeUndefined();
    expect(r.message).toMatch(/no public repo acme\/ghost/);
    expect(r.message).toMatch(/precomputed repos in `available`/);
    expect(r.available.length).toBe(4);
  });

  it('does not try to build a snapshot id, a bare name or text that is not a repo', async () => {
    const calls: string[] = [];
    const t = graphTools(calls);
    for (const repo of ['acme__widgets@1234567', 'express', 'not a repo!']) {
      const r = (await t.buildGraph({ repo }, ctx)) as unknown as { status: string };
      expect(r.status, repo).toBe('unavailable');
    }
    expect(calls).toEqual([]);
  });

  it('says what to do when a live snapshot has expired, on tools that take a snapshot id', async () => {
    const t = graphTools();
    await expect(t.projectOverview({ snapshotId: 'acme__widgets@bbbbbbb' }, ctx)).rejects.toThrow(/call build_graph with acme\/widgets again/);
  });

  it('shows an unknown owner/repo handed to another tool the same hint', async () => {
    const t = graphTools();
    await expect(t.projectOverview({ snapshotId: 'acme/widgets' }, ctx)).rejects.toThrow(/Call build_graph with this repo first/);
  });
});
