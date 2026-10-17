import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { IssuesFileSchema, type IssuesFile } from '../issues.schema.js';
import { SnapshotSchema, parseSnapshotId, snapshotId, type Snapshot } from '../snapshot.schema.js';

/**
 * Where snapshots built on demand live. One shared instance, so every tool sees what
 * build_graph built. Memory first (a few repos, newest kept, entries expire), plus a best-effort
 * copy in the OS temp folder so a restarted worker on the same machine can pick it back up.
 * /app is read-only on NitroCloud; the temp folder is the only writable place and may vanish.
 */

export interface LiveEntry {
  snapshot: Snapshot;
  issues: IssuesFile;
  /** ms since epoch when it was built. */
  at: number;
}

export class LiveRegistry {
  max = 8;
  ttlMs = (Number(process.env.LIVE_SNAPSHOT_TTL_MIN) > 0 ? Number(process.env.LIVE_SNAPSHOT_TTL_MIN) : 360) * 60_000;
  /** Overridable in tests; set to null to disable the temp-folder copy. */
  tmpDir: string | null = path.join(os.tmpdir(), 'repoatlas-live');

  private readonly entries = new Map<string, LiveEntry>();

  clear(): void {
    this.entries.clear();
  }

  private fresh(e: LiveEntry): boolean {
    return Date.now() - e.at <= this.ttlMs;
  }

  /** Live snapshots currently in memory, most recently used first. */
  list(): LiveEntry[] {
    for (const [id, e] of this.entries) if (!this.fresh(e)) this.entries.delete(id);
    return [...this.entries.values()].reverse(); // the map is kept in use order, so the newest come first
  }

  async put(snapshot: Snapshot, issues: IssuesFile): Promise<string> {
    const id = snapshotId(snapshot.repo, snapshot.sha);
    this.entries.delete(id);
    this.entries.set(id, { snapshot, issues, at: Date.now() });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
    if (this.tmpDir && parseSnapshotId(id)) {
      try {
        await fs.mkdir(this.tmpDir, { recursive: true });
        await fs.writeFile(path.join(this.tmpDir, `${id}.json`), JSON.stringify({ snapshot, issues }), 'utf8');
      } catch {
        // the copy is a convenience only
      }
    }
    return id;
  }

  /** In memory, else restored from the temp copy. Marks the entry most recently used. */
  async get(id: string): Promise<LiveEntry | undefined> {
    const hit = this.entries.get(id);
    if (hit) {
      if (!this.fresh(hit)) {
        this.entries.delete(id);
        return undefined;
      }
      this.entries.delete(id);
      this.entries.set(id, hit);
      return hit;
    }
    if (!this.tmpDir || !parseSnapshotId(id)) return undefined; // the id becomes a file name: only accept the exact shape
    try {
      const file = path.join(this.tmpDir, `${id}.json`);
      const stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs > this.ttlMs) return undefined;
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { snapshot?: unknown; issues?: unknown };
      const snap = SnapshotSchema.safeParse(raw.snapshot);
      const iss = IssuesFileSchema.safeParse(raw.issues);
      if (!snap.success || !iss.success || snap.data.source?.kind !== 'live') return undefined;
      const entry: LiveEntry = { snapshot: snap.data, issues: iss.data, at: stat.mtimeMs };
      this.entries.set(id, entry);
      while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
      return entry;
    } catch {
      return undefined;
    }
  }

  /** Newest fresh entry for `owner/repo` (case-insensitive). */
  findByRepo(repo: string): LiveEntry | undefined {
    const want = repo.toLowerCase();
    return this.list().find((e) => e.snapshot.repo.toLowerCase() === want);
  }
}

export const liveRegistry = new LiveRegistry();

/** On by default. Set LIVE_BUILDS=off to serve only the precomputed repos. */
export function liveEnabled(): boolean {
  return (process.env.LIVE_BUILDS ?? 'on').trim().toLowerCase() !== 'off';
}
