import { buildLiveSnapshot, type LiveBuildOptions, type LiveBuildResult } from './build-live.js';
import { LiveBuildError } from './fetch-tarball.js';
import { liveEnabled, liveRegistry, type LiveRegistry } from './registry.js';
import { parseRepoSpec, type RepoSpec } from './repo-spec.js';
import type { Snapshot } from '../snapshot.schema.js';

/**
 * Front door for on-demand builds: is it allowed, has this repo just been built, is the server
 * busy, has the hourly cap been reached. Builds are expensive (a download plus parsing), so the
 * free tier is protected by a concurrency limit, an hourly cap and reuse of recent results.
 */

export interface LiveBuildDeps {
  build?: (spec: RepoSpec, o: LiveBuildOptions) => Promise<LiveBuildResult>;
  registry?: LiveRegistry;
  options?: LiveBuildOptions;
}

export class LiveBuildService {
  /** At most this many builds run at once; others wait up to waitMs, then get a "busy" message. */
  maxConcurrent = 2;
  waitMs = 20_000;
  maxPerHour = Number(process.env.LIVE_BUILDS_PER_HOUR) > 0 ? Number(process.env.LIVE_BUILDS_PER_HOUR) : 40;

  private running = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly starts: number[] = [];
  private readonly inflight = new Map<string, Promise<Snapshot>>();
  private readonly build: NonNullable<LiveBuildDeps['build']>;
  private readonly registry: LiveRegistry;
  private readonly options: LiveBuildOptions;

  constructor(deps: LiveBuildDeps = {}) {
    this.build = deps.build ?? buildLiveSnapshot;
    this.registry = deps.registry ?? liveRegistry;
    this.options = deps.options ?? {};
  }

  enabled(): boolean {
    return liveEnabled();
  }

  /** The repo a reference points at, when it is one this service could build. */
  specOf(ref: string): RepoSpec | null {
    return this.enabled() ? parseRepoSpec(ref) : null;
  }

  async buildFor(ref: string): Promise<{ snapshot: Snapshot; cached: boolean }> {
    if (!this.enabled()) throw new LiveBuildError('disabled', 'Building new repos is switched off on this server. Use one of the precomputed repos.');
    const spec = parseRepoSpec(ref);
    if (!spec) throw new LiveBuildError('bad_ref', `Could not read "${ref.slice(0, 80)}" as a GitHub repo. Use owner/repo or a github.com URL.`);

    const recent = this.registry.findByRepo(spec.repo);
    if (recent) return { snapshot: recent.snapshot, cached: true };

    const key = spec.repo.toLowerCase();
    const running = this.inflight.get(key);
    if (running) return { snapshot: await running, cached: true };

    const job = this.run(spec).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return { snapshot: await job, cached: false };
  }

  private async run(spec: RepoSpec): Promise<Snapshot> {
    const hourAgo = Date.now() - 3_600_000;
    while (this.starts.length && this.starts[0] < hourAgo) this.starts.shift();
    if (this.starts.length >= this.maxPerHour) {
      const mins = Math.max(1, Math.ceil((this.starts[0] + 3_600_000 - Date.now()) / 60_000));
      throw new LiveBuildError('rate_limited', `This server has already built ${this.maxPerHour} new repos in the last hour (a limit that protects the free tier). Try a precomputed repo, or again in about ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
    await this.acquire();
    try {
      this.starts.push(Date.now());
      const token = process.env.GITHUB_TOKEN?.trim() || undefined;
      let result: LiveBuildResult;
      try {
        result = await this.build(spec, { ...this.options, token });
      } catch (e) {
        if (e instanceof LiveBuildError) throw e;
        throw new LiveBuildError('failed', `Building ${spec.repo} failed unexpectedly. Try again, or use a precomputed repo.`);
      }
      await this.registry.put(result.snapshot, result.issues);
      return result.snapshot;
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const start = (): void => {
        clearTimeout(timer);
        this.running++;
        resolve();
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(start);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new LiveBuildError('busy', 'The server is busy building other repos. Try again in a minute.'));
      }, this.waitMs);
      this.waiters.push(start);
    });
  }

  private release(): void {
    this.running--;
    this.waiters.shift()?.();
  }
}

/** Shared by every tool, so limits and reuse hold across the whole server. */
export const liveBuilds = new LiveBuildService();
