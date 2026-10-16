import { Injectable } from '@nitrostack/core';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  MAX_SNAPSHOT_BYTES,
  NODE_KINDS,
  EDGE_KINDS,
  SnapshotSchema,
  getFileMeta,
  normalizeRepoRef,
  parseSnapshotId,
  repoKey,
  snapshotId,
  type Snapshot,
} from './snapshot.schema.js';

export * from './snapshot.schema.js';

export type SnapshotErrorCode = 'not_found' | 'bad_ref' | 'invalid' | 'too_large';

/** Carries a message that is safe to show to the agent (no absolute paths, no secrets). */
export class SnapshotError extends Error {
  constructor(
    public readonly code: SnapshotErrorCode,
    message: string,
    public readonly available: string[] = [],
  ) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export interface SnapshotInfo {
  id: string;
  /** File stem, usable as an alias (e.g. `sample`). */
  file: string;
  repo: string;
  sha: string;
  builtAt: string;
  tier: 1 | 2;
  truncated: boolean;
}

export interface SnapshotSummary {
  id: string;
  uri: string;
  repo: string;
  sha: string;
  builtAt: string;
  tier: 1 | 2;
  tierMeaning: string;
  truncated: boolean;
  commitWindow: number;
  counts: { nodes: Record<string, number>; edges: Record<string, number> };
  languages: Record<string, number>;
  topDirs: { path: string; files: number }[];
  entryPoints: string[];
  /** Plain-language limits the agent should repeat to the user. */
  limits: string[];
}

const TIER_MEANING: Record<1 | 2, string> = {
  1: 'Tier 1: file tree, history and people only (no import graph for this repo).',
  2: 'Tier 2: file tree, history, people and an import graph for JS/TS and Python.',
};

const STEM_RE = /^[A-Za-z0-9._@-]+$/;
const ISSUES_SUFFIX = '.issues.json';

/** Pure: build the compact summary used by the resource and `build_graph`. */
export function summarize(snap: Snapshot): SnapshotSummary {
  const id = snapshotId(snap.repo, snap.sha);
  const nodeCounts: Record<string, number> = Object.fromEntries(NODE_KINDS.map((k) => [k, 0]));
  const edgeCounts: Record<string, number> = Object.fromEntries(EDGE_KINDS.map((k) => [k, 0]));
  const languages: Record<string, number> = {};
  const dirFiles = new Map<string, number>();
  const entryPoints: string[] = [];

  for (const n of snap.nodes) {
    nodeCounts[n.kind] += 1;
    if (n.kind !== 'file') continue;
    const meta = getFileMeta(n);
    if (meta.lang) languages[meta.lang] = (languages[meta.lang] ?? 0) + 1;
    const p = meta.path ?? n.id.slice('file:'.length);
    const top = p.includes('/') ? p.split('/')[0] : '.';
    dirFiles.set(top, (dirFiles.get(top) ?? 0) + 1);
    if (meta.isEntry) entryPoints.push(p);
  }
  for (const e of snap.edges) edgeCounts[e.kind] += 1;

  const limits = [
    TIER_MEANING[snap.tier],
    `History covers the last ${snap.commitWindow} commits only.`,
    `Snapshot of commit ${snap.sha.slice(0, 7)}, built ${snap.builtAt}; the repo may have changed since.`,
  ];
  if (snap.truncated) {
    limits.push('Truncated: size caps were applied, so this is a partial graph of the repo.');
  }

  return {
    id,
    uri: `graph://${repoKey(snap.repo)}@${snap.sha.slice(0, 7)}/summary`,
    repo: snap.repo,
    sha: snap.sha,
    builtAt: snap.builtAt,
    tier: snap.tier,
    tierMeaning: TIER_MEANING[snap.tier],
    truncated: snap.truncated,
    commitWindow: snap.commitWindow,
    counts: { nodes: nodeCounts, edges: edgeCounts },
    languages,
    topDirs: [...dirFiles.entries()]
      .map(([p, files]) => ({ path: p, files }))
      .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path)),
    entryPoints: entryPoints.sort(),
    limits,
  };
}

/**
 * Loads snapshots from SNAPSHOT_DIR (default `data/snapshots`, relative to the working
 * directory; `/app` on NitroCloud, where it is read-only). Files are validated once,
 * indexed lazily, and the three most recently used snapshots stay in memory.
 */
@Injectable()
export class StoreService {
  /** Overridable in tests. */
  dir: string = process.env.SNAPSHOT_DIR || 'data/snapshots';
  maxCached = 3;

  private index: Map<string, SnapshotInfo> | null = null;
  private skipped: { file: string; reason: string }[] = [];
  private readonly cache = new Map<string, Snapshot>();

  private get absDir(): string {
    return path.resolve(process.cwd(), this.dir);
  }

  /** Drop caches so the next call rescans the directory. */
  reset(): void {
    this.index = null;
    this.skipped = [];
    this.cache.clear();
  }

  /** Files that were present but could not be used, with a reason (for diagnostics). */
  async problems(): Promise<{ file: string; reason: string }[]> {
    await this.ensureIndex();
    return [...this.skipped];
  }

  async list(): Promise<SnapshotInfo[]> {
    const idx = await this.ensureIndex();
    return [...idx.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Turn an id, alias, `owner/repo`, `owner__repo` or GitHub URL into a snapshot id. */
  async resolve(ref: string): Promise<string> {
    const idx = await this.ensureIndex();
    const available = [...idx.keys()].sort();
    const raw = (ref ?? '').trim();
    if (!raw) throw new SnapshotError('bad_ref', 'Give a snapshot id (owner__repo@sha7), an owner/repo, or a GitHub URL.', available);

    if (idx.has(raw)) return raw;
    for (const info of idx.values()) if (info.file === raw) return info.id;

    const asId = parseSnapshotId(raw);
    if (asId) {
      const sameRepo = this.newestFor(idx, asId.repo);
      throw new SnapshotError(
        'not_found',
        sameRepo
          ? `No snapshot ${raw}. This server has ${sameRepo.id} for ${asId.repo}; use that id.`
          : `No snapshot ${raw}. Available snapshots: ${available.join(', ') || 'none'}.`,
        available,
      );
    }

    const repo = normalizeRepoRef(raw);
    if (!repo) {
      throw new SnapshotError('bad_ref', `Could not read "${raw.slice(0, 80)}" as a snapshot id, owner/repo or GitHub URL.`, available);
    }
    const found = this.newestFor(idx, repo);
    if (found) return found.id;
    throw new SnapshotError(
      'not_found',
      `No snapshot for ${repo}. RepoAtlas runs in snapshot mode: it only serves repos precomputed ahead of time. Available snapshots: ${available.join(', ') || 'none'}.`,
      available,
    );
  }

  async load(ref: string): Promise<Snapshot> {
    const id = await this.resolve(ref);
    const hit = this.cache.get(id);
    if (hit) {
      this.cache.delete(id);
      this.cache.set(id, hit); // mark most recently used
      return hit;
    }
    const info = this.index!.get(id)!;
    const snap = await this.readValidated(info.file);
    this.cache.set(id, snap);
    while (this.cache.size > this.maxCached) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return snap;
  }

  async summary(ref: string): Promise<SnapshotSummary> {
    return summarize(await this.load(ref));
  }

  /** Ids currently held in memory, oldest first (for tests and diagnostics). */
  cachedIds(): string[] {
    return [...this.cache.keys()];
  }

  // --- internals -----------------------------------------------------------

  private newestFor(idx: Map<string, SnapshotInfo>, repo: string): SnapshotInfo | undefined {
    const want = repo.toLowerCase();
    return [...idx.values()]
      .filter((i) => i.repo.toLowerCase() === want)
      .sort((a, b) => b.builtAt.localeCompare(a.builtAt))[0];
  }

  private async ensureIndex(): Promise<Map<string, SnapshotInfo>> {
    if (this.index) return this.index;
    const idx = new Map<string, SnapshotInfo>();
    const skipped: { file: string; reason: string }[] = [];
    let names: string[] = [];
    try {
      names = await fs.readdir(this.absDir);
    } catch {
      // Missing directory means no snapshots; callers get a clear not_found message.
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || name.endsWith(ISSUES_SUFFIX)) continue;
      const stem = name.slice(0, -'.json'.length);
      if (!STEM_RE.test(stem)) continue;
      try {
        const snap = await this.readValidated(stem);
        const id = snapshotId(snap.repo, snap.sha);
        if (idx.has(id)) {
          skipped.push({ file: name, reason: `duplicate of ${idx.get(id)!.file}.json (same repo and sha)` });
          continue;
        }
        idx.set(id, { id, file: stem, repo: snap.repo, sha: snap.sha, builtAt: snap.builtAt, tier: snap.tier, truncated: snap.truncated });
      } catch (e) {
        skipped.push({ file: name, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    this.index = idx;
    this.skipped = skipped;
    return idx;
  }

  private async readValidated(stem: string): Promise<Snapshot> {
    if (!STEM_RE.test(stem)) throw new SnapshotError('bad_ref', `Unsafe snapshot file name "${stem.slice(0, 60)}".`);
    const file = path.join(this.absDir, `${stem}.json`);
    const stat = await fs.stat(file);
    if (stat.size > MAX_SNAPSHOT_BYTES) {
      throw new SnapshotError('too_large', `${stem}.json is ${(stat.size / 1048576).toFixed(1)} MB; the limit is ${MAX_SNAPSHOT_BYTES / 1048576} MB.`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      throw new SnapshotError('invalid', `${stem}.json is not valid JSON.`);
    }
    const parsed = SnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      throw new SnapshotError('invalid', `${stem}.json failed validation (${parsed.error.issues.length} issues): ${first.join('; ')}`);
    }
    return parsed.data;
  }
}
