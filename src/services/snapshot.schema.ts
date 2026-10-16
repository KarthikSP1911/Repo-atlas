import { z } from 'zod';

/**
 * Snapshot schema (blueprint section 5).
 *
 * A snapshot is one JSON file per repo and commit SHA. It is built offline by
 * `npm run precompute` and shipped in the deploy zip; the server only reads it.
 * Node text (commit messages, issue titles, README titles) is untrusted data.
 * Never put secrets or email addresses in a snapshot.
 */

export const SCHEMA_VERSION = 1;

/** Snapshot files above this size are rejected (keeps the deploy zip and memory small). */
export const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;
export const MAX_NODES = 25_000;
export const MAX_EDGES = 100_000;

export const NODE_KINDS = ['dir', 'file', 'entry', 'commit', 'pr', 'issue', 'person', 'doc'] as const;
export const EDGE_KINDS = [
  'contains',
  'imports',
  'starts',
  'touches',
  'fixes',
  'authored',
  'reviewed',
  'describes',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Node ids are `<kind>:<key>`, e.g. `file:src/index.ts`, `pr:12`, `person:alice`. */
export const GNodeSchema = z.object({
  id: z.string().min(3).max(400),
  kind: z.enum(NODE_KINDS),
  label: z.string().max(400),
  meta: z.record(z.unknown()),
});

export const GEdgeSchema = z.object({
  from: z.string().min(3).max(400),
  to: z.string().min(3).max(400),
  kind: z.enum(EDGE_KINDS),
  weight: z.number().finite().optional(),
  confidence: z.enum(['exact', 'likely']).optional(),
});

/**
 * Conventional `meta` keys on `file` nodes. Every key is optional; unknown keys
 * are allowed. Services read them through `getFileMeta`.
 */
export const FileMetaSchema = z
  .object({
    path: z.string(),
    lang: z.string(),
    loc: z.number().int().nonnegative(),
    fanIn: z.number().int().nonnegative(),
    fanOut: z.number().int().nonnegative(),
    centrality: z.number().min(0).max(1),
    churn: z.number().int().nonnegative(),
    isEntry: z.boolean(),
    isConfig: z.boolean(),
    isTest: z.boolean(),
    testFor: z.array(z.string()),
    docsMentions: z.number().int().nonnegative(),
    lastChangedAt: z.string(),
    owners: z.array(z.string()),
  })
  .partial()
  .passthrough();
export type FileMeta = z.infer<typeof FileMetaSchema>;

export function getFileMeta(node: GNode): FileMeta {
  const parsed = FileMetaSchema.safeParse(node.meta);
  return parsed.success ? parsed.data : {};
}

/** Which node kinds each edge kind may connect (catches engine bugs early). */
const EDGE_ENDPOINTS: Record<EdgeKind, { from: readonly NodeKind[]; to: readonly NodeKind[] }> = {
  contains: { from: ['dir'], to: ['dir', 'file'] },
  imports: { from: ['file'], to: ['file'] },
  starts: { from: ['entry'], to: ['file'] },
  touches: { from: ['commit', 'pr'], to: ['file'] },
  fixes: { from: ['pr', 'commit'], to: ['issue'] },
  authored: { from: ['person'], to: ['commit', 'pr', 'issue'] },
  reviewed: { from: ['person'], to: ['pr'] },
  describes: { from: ['doc'], to: ['file', 'dir'] },
};

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export const SnapshotSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    repo: z.string().regex(REPO_RE, 'repo must look like owner/name'),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/, 'sha must be 7 to 40 lowercase hex characters'),
    builtAt: z.string().datetime(),
    /** 1 = file tree, history and people (any language); 2 = plus import graph. */
    tier: z.union([z.literal(1), z.literal(2)]),
    /** True when size caps (about 1,500 files) were applied. */
    truncated: z.boolean(),
    /** Number of most recent commits the history layer covers. */
    commitWindow: z.number().int().nonnegative(),
    nodes: z.array(GNodeSchema).max(MAX_NODES),
    edges: z.array(GEdgeSchema).max(MAX_EDGES),
  })
  .superRefine((snap, ctx) => {
    const kindById = new Map<string, NodeKind>();
    snap.nodes.forEach((n, i) => {
      if (kindById.has(n.id)) {
        ctx.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: `duplicate node id ${n.id}` });
      }
      kindById.set(n.id, n.kind);
      if (!n.id.startsWith(`${n.kind}:`)) {
        ctx.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: `node id ${n.id} must start with "${n.kind}:"` });
      }
      if ((n.kind === 'file' || n.kind === 'dir') && typeof n.meta.path !== 'string') {
        ctx.addIssue({ code: 'custom', path: ['nodes', i, 'meta', 'path'], message: `${n.kind} node ${n.id} needs meta.path` });
      }
    });
    snap.edges.forEach((e, i) => {
      const from = kindById.get(e.from);
      const to = kindById.get(e.to);
      if (!from) ctx.addIssue({ code: 'custom', path: ['edges', i, 'from'], message: `edge from unknown node ${e.from}` });
      if (!to) ctx.addIssue({ code: 'custom', path: ['edges', i, 'to'], message: `edge to unknown node ${e.to}` });
      if (from && to) {
        const rule = EDGE_ENDPOINTS[e.kind];
        if (!rule.from.includes(from) || !rule.to.includes(to)) {
          ctx.addIssue({
            code: 'custom',
            path: ['edges', i],
            message: `${e.kind} edge may not connect ${from} -> ${to} (${e.from} -> ${e.to})`,
          });
        }
      }
      if ((e.kind === 'fixes' || e.kind === 'describes') && !e.confidence) {
        ctx.addIssue({ code: 'custom', path: ['edges', i, 'confidence'], message: `${e.kind} edge needs a confidence label` });
      }
    });
  });

export type GNode = z.infer<typeof GNodeSchema>;
export type GEdge = z.infer<typeof GEdgeSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;

// --- Snapshot ids ----------------------------------------------------------

/** `owner__repo@sha7`. GitHub owners cannot contain `_`, so the first `__` is the separator. */
const ID_RE = /^([A-Za-z0-9-]+)__([A-Za-z0-9._-]+)@([0-9a-f]{7})$/;

export function snapshotId(repo: string, sha: string): string {
  const [owner, name] = repo.split('/');
  return `${owner}__${name}@${sha.slice(0, 7)}`;
}

export function parseSnapshotId(id: string): { repo: string; sha7: string } | null {
  const m = ID_RE.exec(id);
  return m ? { repo: `${m[1]}/${m[2]}`, sha7: m[3] } : null;
}

/** The repo part of an id, safe for use in a `graph://` URI (no slash). */
export function repoKey(repo: string): string {
  return repo.replace('/', '__');
}

/**
 * Accepts `owner/repo`, `owner__repo`, `github.com/owner/repo`, or a full GitHub URL
 * (with optional `.git`, trailing path, query or fragment). Returns `owner/repo` or null.
 */
export function normalizeRepoRef(ref: string): string | null {
  let s = ref.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/^github\.com\//i, '');
  s = s.split(/[?#]/)[0].replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = /^([A-Za-z0-9-]+)(?:\/|__)([A-Za-z0-9._-]+)(?:\/.*)?$/.exec(s);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}
