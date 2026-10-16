import {
  getFileMeta,
  parseSnapshotId,
  snapshotId,
  type FileMeta,
  type GEdge,
  type GNode,
  type Snapshot,
} from './snapshot.schema.js';

/**
 * Read-only query layer over one validated snapshot. Pure and synchronous; tools and services
 * use it instead of scanning `snapshot.nodes` themselves. Built once per snapshot and cached.
 * All text in node labels and meta (commit subjects, PR and issue titles, README excerpts,
 * docstrings) is UNTRUSTED data written by strangers.
 */

export interface FileView {
  path: string;
  node: GNode;
  meta: FileMeta;
}

export interface ImportLink {
  path: string;
  weight: number;
}

export interface EntryView {
  path: string;
  kind: string;
  reasons: string[];
  command?: string;
  score: number;
}

export interface PersonView {
  id: string;
  label: string;
  login?: string;
  commits: number;
}

export interface CommitView {
  id: string;
  sha7: string;
  subject: string;
  date: string;
  prNumber?: number;
  author?: string;
  files: string[];
}

export interface PrView {
  id: string;
  number: number;
  title: string;
  mergedAt?: string;
  author?: string;
  reviewers: string[];
  files: string[];
  fixes: { issue: number; confidence: 'exact' | 'likely' }[];
}

export interface IssueView {
  id: string;
  number: number;
  title: string;
  state: string;
  stub: boolean;
}

export interface DocView {
  path: string;
  title: string;
  describes: { path: string; isDir: boolean; confidence: 'exact' | 'likely' }[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export class GraphIndex {
  readonly id: string;
  readonly files = new Map<string, FileView>();
  readonly persons = new Map<string, PersonView>();
  readonly entries: EntryView[] = [];
  readonly docs: DocView[] = [];
  readonly commits: CommitView[] = [];
  readonly prs: PrView[] = [];
  readonly issues = new Map<number, IssueView>();
  readonly dirs = new Map<string, { path: string; files: number; tags: Record<string, number> }>();

  private readonly out = new Map<string, ImportLink[]>();
  private readonly inn = new Map<string, ImportLink[]>();
  private readonly byBase = new Map<string, string[]>();
  private readonly commitById = new Map<string, CommitView>();
  private readonly prById = new Map<string, PrView>();

  constructor(readonly snap: Snapshot) {
    this.id = snapshotId(snap.repo, snap.sha);
    const nodeById = new Map<string, GNode>(snap.nodes.map((n) => [n.id, n]));

    for (const n of snap.nodes) {
      if (n.kind === 'file') {
        const meta = getFileMeta(n);
        const path = meta.path ?? n.id.slice('file:'.length);
        this.files.set(path, { path, node: n, meta });
        const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
        this.byBase.set(base, [...(this.byBase.get(base) ?? []), path]);
      } else if (n.kind === 'person') {
        this.persons.set(n.id, { id: n.id, label: n.label, login: str(n.meta.login), commits: num(n.meta.commits) ?? 0 });
      } else if (n.kind === 'entry') {
        this.entries.push({ path: str(n.meta.path) ?? n.id.slice('entry:'.length), kind: str(n.meta.kind) ?? 'main', reasons: (n.meta.reasons as string[] | undefined) ?? [], command: str(n.meta.command), score: num(n.meta.score) ?? 0 });
      } else if (n.kind === 'issue') {
        const number = num(n.meta.number) ?? Number(n.id.slice('issue:'.length));
        this.issues.set(number, { id: n.id, number, title: n.label, state: str(n.meta.state) ?? 'unknown', stub: n.meta.stub === true });
      } else if (n.kind === 'dir') {
        const path = str(n.meta.path) ?? n.id.slice('dir:'.length);
        this.dirs.set(path, { path, files: 0, tags: {} });
      }
    }
    this.entries.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    const commitFiles = new Map<string, string[]>();
    const prFiles = new Map<string, string[]>();
    const authorOf = new Map<string, string>();
    const reviewersOf = new Map<string, string[]>();
    const prFixes = new Map<string, { issue: number; confidence: 'exact' | 'likely' }[]>();
    const docDescribes = new Map<string, DocView['describes']>();

    for (const e of snap.edges) this.addEdge(e, nodeById, { commitFiles, prFiles, authorOf, reviewersOf, prFixes, docDescribes });

    for (const f of this.files.values()) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
      for (let d = dir; ; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '.') {
        const entry = this.dirs.get(d);
        if (entry) {
          entry.files++;
          for (const t of f.meta.tags ?? []) entry.tags[t] = (entry.tags[t] ?? 0) + 1;
        }
        if (d === '.') break;
      }
    }

    for (const n of snap.nodes) {
      if (n.kind === 'commit') {
        const c: CommitView = { id: n.id, sha7: n.id.slice('commit:'.length), subject: n.label, date: str(n.meta.date) ?? '', prNumber: num(n.meta.prNumber), author: authorOf.get(n.id), files: commitFiles.get(n.id) ?? [] };
        this.commits.push(c);
        this.commitById.set(n.id, c);
      } else if (n.kind === 'pr') {
        const p: PrView = { id: n.id, number: num(n.meta.number) ?? 0, title: n.label, mergedAt: str(n.meta.mergedAt), author: authorOf.get(n.id), reviewers: reviewersOf.get(n.id) ?? [], files: prFiles.get(n.id) ?? [], fixes: prFixes.get(n.id) ?? [] };
        this.prs.push(p);
        this.prById.set(n.id, p);
      } else if (n.kind === 'doc') {
        const path = str(n.meta.path) ?? n.id.slice('doc:'.length);
        this.docs.push({ path, title: n.label, describes: docDescribes.get(n.id) ?? [] });
      }
    }
    this.commits.sort((a, b) => b.date.localeCompare(a.date));
  }

  private addEdge(
    e: GEdge,
    nodeById: Map<string, GNode>,
    acc: {
      commitFiles: Map<string, string[]>;
      prFiles: Map<string, string[]>;
      authorOf: Map<string, string>;
      reviewersOf: Map<string, string[]>;
      prFixes: Map<string, { issue: number; confidence: 'exact' | 'likely' }[]>;
      docDescribes: Map<string, DocView['describes']>;
    },
  ): void {
    const push = <T>(m: Map<string, T[]>, k: string, v: T): void => void m.set(k, [...(m.get(k) ?? []), v]);
    const filePath = (id: string): string => id.slice('file:'.length);
    switch (e.kind) {
      case 'imports': {
        const w = e.weight ?? 1;
        push(this.out, filePath(e.from), { path: filePath(e.to), weight: w });
        push(this.inn, filePath(e.to), { path: filePath(e.from), weight: w });
        break;
      }
      case 'touches':
        push(e.from.startsWith('pr:') ? acc.prFiles : acc.commitFiles, e.from, filePath(e.to));
        break;
      case 'authored':
        if (e.to.startsWith('commit:') || e.to.startsWith('pr:')) acc.authorOf.set(e.to, e.from);
        break;
      case 'reviewed':
        push(acc.reviewersOf, e.to, e.from);
        break;
      case 'fixes':
        if (e.from.startsWith('pr:')) push(acc.prFixes, e.from, { issue: Number(e.to.slice('issue:'.length)), confidence: e.confidence ?? 'likely' });
        break;
      case 'describes': {
        const target = nodeById.get(e.to);
        if (target) push(acc.docDescribes, e.from, { path: str(target.meta.path) ?? e.to.slice(e.to.indexOf(':') + 1), isDir: target.kind === 'dir', confidence: e.confidence ?? 'likely' });
        break;
      }
      default:
        break;
    }
  }

  get repo(): string {
    return this.snap.repo;
  }

  get project(): Record<string, unknown> {
    const root = this.snap.nodes.find((n) => n.id === 'dir:.');
    return (root?.meta.project as Record<string, unknown> | undefined) ?? {};
  }

  get coChange(): { a: string; b: string; count: number }[] {
    const root = this.snap.nodes.find((n) => n.id === 'dir:.');
    return (root?.meta.coChange as { a: string; b: string; count: number }[] | undefined) ?? [];
  }

  getFile(p: string): FileView | undefined {
    return this.files.get(p);
  }

  /** Files this file imports (outgoing edges), heaviest first. */
  imports(p: string): ImportLink[] {
    return [...(this.out.get(p) ?? [])].sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
  }

  /** Files that import this file (incoming edges), most central first. */
  importedBy(p: string): ImportLink[] {
    return [...(this.inn.get(p) ?? [])].sort((a, b) => (this.files.get(b.path)?.meta.centrality ?? 0) - (this.files.get(a.path)?.meta.centrality ?? 0) || a.path.localeCompare(b.path));
  }

  person(id: string): PersonView | undefined {
    return this.persons.get(id);
  }

  /** Human label for a `person:` id (never an email address). */
  personLabel(id: string): string {
    const p = this.persons.get(id);
    return p?.login ?? p?.label ?? id.replace(/^person:/, '');
  }

  commitsTouching(p: string, limit = 5): CommitView[] {
    return this.commits.filter((c) => c.files.includes(p)).slice(0, limit);
  }

  prsTouching(p: string, limit = 5): PrView[] {
    return this.prs.filter((x) => x.files.includes(p)).slice(0, limit);
  }

  /**
   * Find a file from loose input: exact path, case-insensitive path, path suffix, or unique
   * basename. When nothing matches, returns the closest paths so the error can suggest them.
   */
  resolvePath(input: string): { file?: FileView; suggestions: string[] } {
    const raw = input.trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^file:/, '');
    if (!raw) return { suggestions: [] };
    const exact = this.files.get(raw);
    if (exact) return { file: exact, suggestions: [] };
    const lower = raw.toLowerCase();
    const all = [...this.files.keys()];
    const ci = all.filter((p) => p.toLowerCase() === lower);
    if (ci.length === 1) return { file: this.files.get(ci[0]), suggestions: [] };
    const suffix = all.filter((p) => p.toLowerCase().endsWith(`/${lower}`));
    if (suffix.length === 1) return { file: this.files.get(suffix[0]), suggestions: [] };
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    const sameBase = this.byBase.get(base) ?? [];
    if (sameBase.length === 1) return { file: this.files.get(sameBase[0]), suggestions: [] };
    const candidates = [...new Set([...suffix, ...sameBase, ...all.filter((p) => p.toLowerCase().includes(base)).slice(0, 8)])];
    return { suggestions: candidates.slice(0, 5) };
  }
}

const cache = new WeakMap<Snapshot, GraphIndex>();

export function indexFor(snap: Snapshot): GraphIndex {
  let idx = cache.get(snap);
  if (!idx) {
    idx = new GraphIndex(snap);
    cache.set(snap, idx);
  }
  return idx;
}

export { parseSnapshotId };
