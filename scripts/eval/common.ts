import 'dotenv/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GraphIndex } from '../../src/services/graph.query.js';
import { fetchGraphql, type GraphqlFn } from '../../src/services/github.graphql.js';
import { scrubEmails } from '../../src/services/privacy.js';
import { StoreService, type Snapshot } from '../../src/services/store.service.js';
import type { IssuesFile } from '../../src/services/issues.schema.js';

/** Shared helpers for the evaluation scripts. Offline only: they read data/snapshots and may call GitHub with GITHUB_TOKEN. */

export interface Demo {
  id: string;
  repo: string;
  snap: Snapshot;
  idx: GraphIndex;
  issues: IssuesFile | null;
}

export async function loadDemos(): Promise<Demo[]> {
  const store = new StoreService();
  store.dir = 'data/snapshots';
  const out: Demo[] = [];
  for (const info of await store.list()) {
    if (info.file === 'sample') continue;
    const snap = await store.load(info.id);
    out.push({ id: info.id, repo: info.repo, snap, idx: new GraphIndex(snap), issues: await store.loadIssues(info.id) });
  }
  return out;
}

export function graphqlOrNull(): GraphqlFn | null {
  const token = process.env.GITHUB_TOKEN?.trim();
  return token ? fetchGraphql(token) : null;
}

export const CACHE_DIR = path.resolve('scripts/eval/.cache');

export async function readCache<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(CACHE_DIR, name), 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function writeCache(name: string, data: unknown): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(path.join(CACHE_DIR, name), JSON.stringify(data));
}

// --- PR details from GitHub (first-timer status, issue bodies, creation time) ------------------

export interface PrDetails {
  number: number;
  association: string;
  createdAt: string;
  mergedAt: string | null;
  issues: { number: number; title: string; body: string }[];
}

export async function fetchPrDetails(gql: GraphqlFn, repo: string, numbers: number[]): Promise<{ details: PrDetails[]; calls: number; cost: number }> {
  const [owner, name] = repo.split('/');
  const details: PrDetails[] = [];
  let calls = 0;
  let cost = 0;
  for (let i = 0; i < numbers.length; i += 25) {
    const chunk = numbers.slice(i, i + 25);
    const fields = chunk
      .map((n) => `p${n}: pullRequest(number: ${n}) { number authorAssociation createdAt mergedAt closingIssuesReferences(first: 3) { nodes { number title body } } }`)
      .join('\n');
    const res = await gql(`query($owner:String!,$name:String!){ rateLimit{cost remaining} repository(owner:$owner,name:$name){ ${fields} } }`, { owner, name });
    calls++;
    cost += res.rateLimit?.cost ?? 0;
    for (const n of chunk) {
      const p = res.repository?.[`p${n}`];
      if (!p) continue;
      details.push({
        number: p.number,
        association: String(p.authorAssociation ?? 'NONE'),
        createdAt: p.createdAt,
        mergedAt: p.mergedAt ?? null,
        issues: (p.closingIssuesReferences?.nodes ?? []).map((x: { number: number; title: string; body: string }) => ({
          number: x.number,
          title: scrubEmails(String(x.title ?? '')).slice(0, 400),
          body: scrubEmails(String(x.body ?? '')).slice(0, 2000),
        })),
      });
    }
  }
  return { details, calls, cost };
}

// --- History before a point in time (no leakage from the PR being predicted) -----------------

/**
 * A copy of the snapshot as it would have looked just before `cutoffIso`: only PRs merged and
 * commits dated before the cutoff survive, each file's last-changed date is recomputed from the
 * surviving commits (unknown when none touched it), and `builtAt` is the cutoff. The text index
 * still uses today's file names and symbols, which cannot be rewound; the report says so.
 */
export function snapshotBefore(snap: Snapshot, cutoffIso: string): Snapshot {
  const keepNode = new Set<string>();
  for (const n of snap.nodes) {
    if (n.kind === 'pr') {
      const merged = typeof n.meta.mergedAt === 'string' ? n.meta.mergedAt : '';
      if (merged && merged < cutoffIso) keepNode.add(n.id);
    } else if (n.kind === 'commit') {
      const date = typeof n.meta.date === 'string' ? n.meta.date : '';
      if (date && date < cutoffIso) keepNode.add(n.id);
    } else {
      keepNode.add(n.id);
    }
  }
  const edges = snap.edges.filter((e) => keepNode.has(e.from) && keepNode.has(e.to));
  const lastChanged = new Map<string, string>();
  const commitDate = new Map(snap.nodes.filter((n) => n.kind === 'commit').map((n) => [n.id, String(n.meta.date ?? '')]));
  for (const e of edges) {
    if (e.kind === 'touches' && e.from.startsWith('commit:')) {
      const d = commitDate.get(e.from) ?? '';
      const f = e.to.slice('file:'.length);
      if (d && (!lastChanged.has(f) || d > lastChanged.get(f)!)) lastChanged.set(f, d);
    }
  }
  const nodes = snap.nodes
    .filter((n) => keepNode.has(n.id))
    .map((n) => {
      if (n.kind !== 'file') return n;
      const { lastChangedAt: _drop, ...rest } = n.meta as Record<string, unknown>;
      const d = lastChanged.get(String(n.meta.path ?? n.id.slice('file:'.length)));
      return { ...n, meta: d ? { ...rest, lastChangedAt: d } : rest };
    });
  return { ...snap, builtAt: cutoffIso, nodes, edges };
}

// --- Small metrics helpers ---------------------------------------------------------------------

export const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Probability that 5 files drawn at random from `n` contain at least one of `k` target files. */
export function randomHitAt(n: number, k: number, top = 5): number {
  if (k <= 0 || n <= 0) return 0;
  if (n - k < top) return 1;
  let miss = 1;
  for (let i = 0; i < top; i++) miss *= (n - k - i) / (n - i);
  return 1 - miss;
}

export function csvCell(v: unknown): string {
  const s = String(v ?? '').replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(',');
