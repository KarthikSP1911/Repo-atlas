import { ToolDecorator as Tool, z, ExecutionContext, Injectable } from '@nitrostack/core';
import { StoreService, SnapshotError } from '../../services/store.service.js';
import { indexFor } from '../../services/graph.query.js';
import { overviewOf, readyResult, unavailableResult } from '../../services/overview.service.js';
import { SNAPSHOT_ID_DESCRIPTION, UNTRUSTED_NOTE, loadIndex, withLimits } from '../../services/tool.util.js';

/**
 * Foundation and overview tools. build_graph does not build anything at request time: NitroCloud
 * has no git binary (docs/SPIKE.md), so it resolves a repo to a snapshot precomputed offline.
 */
@Injectable()
export class GraphTools {
  constructor(private readonly store: StoreService) {}

  @Tool({
    name: 'ping_repoatlas',
    description:
      'Health ping for the RepoAtlas server. Returns the server name, version, runtime mode and whether EXPORT_SECRET is configured (a boolean, never the value). Takes no repo data.',
    inputSchema: z.object({
      echo: z.string().max(100).optional().describe('Optional text to echo back'),
    }),
    examples: {
      request: { echo: 'hello' },
      response: { ok: true, server: 'repoatlas', version: '1.0.0', runtimeMode: 'snapshot', exportSecretConfigured: true, echo: 'hello' },
    },
  })
  async ping(input: { echo?: string }, ctx: ExecutionContext) {
    ctx.logger.info('ping_repoatlas called');
    return {
      ok: true,
      server: 'repoatlas',
      version: '1.0.0',
      runtimeMode: process.env.RUNTIME_MODE ?? 'snapshot',
      exportSecretConfigured: Boolean(process.env.EXPORT_SECRET),
      echo: input.echo ?? null,
    };
  }

  @Tool({
    name: 'build_graph',
    description:
      'Start here. Resolves a GitHub repo (owner/repo, owner__repo, or a github.com URL) to a precomputed graph snapshot and returns its snapshotId, tier (1 = file tree, history and people; 2 = plus import graph), whether it was truncated, the commit window, an as-of time and basic stats. RepoAtlas runs in snapshot mode: it cannot clone repos on demand, so unknown repos return status "unavailable" with the list of repos it does have. Pass the snapshotId to every other tool. Makes no GitHub calls.',
    inputSchema: z.object({
      repo: z.string().min(1).max(300).describe('Repo as owner/repo, owner__repo, a github.com URL, or a snapshot id like owner__repo@abc1234'),
    }),
    examples: {
      request: { repo: 'demo/sample-shop' },
      response: {
        status: 'ready',
        message: 'Snapshot demo__sample-shop@5a3f0c1 is loaded. Pass this snapshotId to every other RepoAtlas tool.',
        snapshotId: 'demo__sample-shop@5a3f0c1',
        repo: 'demo/sample-shop',
        asOf: '2026-10-16T12:00:00Z',
        tier: 2,
        truncated: false,
        commitWindow: 200,
        stats: { files: 16, dirs: 8, importEdges: 19, commitsInGraph: 4, mergedPrs: 3, people: 3, languages: { ts: 11 } },
        available: [{ snapshotId: 'demo__sample-shop@5a3f0c1', repo: 'demo/sample-shop', tier: 2, builtAt: '2026-10-16T12:00:00Z' }],
        nextSteps: ['project_overview(snapshotId)', 'find_entry_points(snapshotId)', 'key_files(snapshotId, role)', 'tour_next(snapshotId, role, stage: 1)'],
      },
    },
  })
  async buildGraph(input: { repo: string }, ctx: ExecutionContext) {
    const infos = await this.store.list();
    try {
      const snap = await this.store.load(input.repo);
      ctx.logger.info('build_graph resolved', { id: indexFor(snap).id });
      return withLimits(snap, readyResult(indexFor(snap), infos));
    } catch (e) {
      if (e instanceof SnapshotError) return unavailableResult(e.message, infos);
      throw e;
    }
  }

  @Tool({
    name: 'project_overview',
    description: `What the project is: description, stack, languages, package manager, run steps (marked inferred when they are the usual commands for the tooling rather than read from a file), folder roles and entry points, with the evidence for each. Reads only the precomputed snapshot (zero GitHub calls). ${UNTRUSTED_NOTE}`,
    inputSchema: z.object({
      snapshotId: z.string().min(1).describe(SNAPSHOT_ID_DESCRIPTION),
    }),
    examples: {
      request: { snapshotId: 'demo__sample-shop@5a3f0c1' },
      response: {
        repo: 'demo/sample-shop',
        name: 'shop',
        description: 'A shop API',
        stack: ['Express', 'TypeScript'],
        languages: { ts: 11 },
        runSteps: [{ step: 'run', command: 'npm start', source: 'package.json scripts.start (node dist/index.js)', inferred: false }],
        folders: [{ path: 'src', files: 8, tags: ['service', 'route'], role: 'main source code', evidence: '8 files (3 service, 2 route)' }],
        entryPoints: [{ path: 'src/index.ts', kind: 'main', reasons: ['package.json main'] }],
        counts: { files: 16, dirs: 8, commitsInGraph: 4, mergedPrs: 3, people: 3, docs: 2 },
        evidence: ['Folder roles are inferred from path names and file role tags across 16 files.'],
        limits: { snapshotId: 'demo__sample-shop@5a3f0c1', asOf: '2026-10-16T12:00:00Z', tier: 2, truncated: false, commitWindow: 200 },
      },
    },
  })
  async projectOverview(input: { snapshotId: string }, ctx: ExecutionContext) {
    const idx = await loadIndex(this.store, input.snapshotId);
    ctx.logger.info('project_overview', { id: idx.id });
    return withLimits(idx.snap, overviewOf(idx));
  }
}
