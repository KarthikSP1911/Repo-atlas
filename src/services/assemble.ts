import { SnapshotSchema, snapshotId, type GEdge, type GNode, type Snapshot, SCHEMA_VERSION } from './snapshot.schema.js';
import type { Analysis } from './graph.service.js';
import { scrubEmails } from './privacy.js';
import { isBot, personSlug, type HistoryCommit } from './people.js';
import type { GithubData } from './github.fetch.js';
import type { ParseResult } from './parse.common.js';

/**
 * Assembles a Snapshot from parsed files, analysis, history and GitHub data. Pure; no heavy
 * imports, so both the offline precompute and the live on-demand build use it.
 */

/** The parts of an ingest result that assembly needs (IngestResult satisfies this). */
export interface AssembleIngest {
  repo: string;
  sha: string;
  defaultBranch: string;
  files: { path: string }[];
}

const MAX_TOUCH_FILES = 40;
const MAX_PERSONS = 200;
const sha7 = (sha: string): string => sha.slice(0, 7);
const parentDir = (x: string): string => (x.includes('/') ? x.slice(0, x.lastIndexOf('/')) : '.');

export interface AssembleParams {
  ingest: AssembleIngest;
  parse: ParseResult;
  analysis: Analysis;
  history: HistoryCommit[];
  github: GithubData;
  builtAt: string;
  commitLimit: number;
  withSymbols: boolean;
  withPrFiles: boolean;
  truncated: boolean;
}

/** Build the snapshot object. Pure: the same inputs always give the same output. */
export function assemble(p: AssembleParams): Snapshot {
  const { ingest, parse, analysis, history, github } = p;
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const nodeIds = new Set<string>();
  const nodeById = new Map<string, GNode>();
  const edgeKeys = new Set<string>();
  const addNode = (n: GNode): void => {
    if (nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodeById.set(n.id, n);
    nodes.push(n);
  };
  const addEdge = (e: GEdge): void => {
    const k = `${e.from}|${e.to}|${e.kind}`;
    if (edgeKeys.has(k) || !nodeIds.has(e.from) || !nodeIds.has(e.to)) return;
    edgeKeys.add(k);
    edges.push(e);
  };
  const filePaths = new Set(ingest.files.map((f) => f.path));

  // Structure: directories, files, contains edges.
  const dirs = new Set<string>(['.']);
  for (const f of ingest.files) for (let d = parentDir(f.path); d !== '.'; d = parentDir(d)) dirs.add(d);
  const rootMeta: Record<string, unknown> = {
    path: '.',
    project: {
      ...analysis.project,
      readmeTitle: analysis.project.readmeTitle && scrubEmails(analysis.project.readmeTitle),
      readmeExcerpt: analysis.project.readmeExcerpt && scrubEmails(analysis.project.readmeExcerpt),
      description: scrubEmails(analysis.project.description ?? github.description ?? '') || undefined,
      license: analysis.project.license ?? github.license ?? undefined,
      primaryLanguage: github.primaryLanguage ?? undefined,
      defaultBranch: github.defaultBranch ?? ingest.defaultBranch,
    },
    coChange: analysis.coChange,
  };
  for (const d of [...dirs].sort()) {
    addNode({ id: `dir:${d}`, kind: 'dir', label: d === '.' ? '/' : d.slice(d.lastIndexOf('/') + 1), meta: d === '.' ? rootMeta : { path: d } });
  }
  for (const d of [...dirs].filter((x) => x !== '.').sort()) addEdge({ from: `dir:${parentDir(d)}`, to: `dir:${d}`, kind: 'contains' });

  for (const f of ingest.files) {
    const a = analysis.files.get(f.path)!;
    const parsed = parse.files.get(f.path);
    const meta: Record<string, unknown> = {
      path: f.path,
      lang: parsed?.lang ?? 'other',
      loc: parsed?.loc ?? 0,
      fanIn: a.fanIn,
      fanOut: a.fanOut,
      centrality: a.centrality,
      churn: a.churn,
    };
    if (a.isEntry) meta.isEntry = true;
    if (a.isConfig) meta.isConfig = true;
    if (a.isTest) meta.isTest = true;
    if (a.docsMentions) meta.docsMentions = a.docsMentions;
    if (a.lastChangedAt) meta.lastChangedAt = a.lastChangedAt;
    if (a.owners.length) meta.owners = a.owners;
    if (a.testFor.length) meta.testFor = a.testFor;
    if (a.testedBy.length) meta.testedBy = a.testedBy;
    if (a.tags.length) meta.tags = a.tags;
    if (p.withSymbols && parsed) {
      if (parsed.exports.length) meta.exports = parsed.exports;
      if (parsed.symbols.length) meta.symbols = parsed.symbols;
      if (parsed.doc) meta.doc = scrubEmails(parsed.doc);
    }
    addNode({ id: `file:${f.path}`, kind: 'file', label: f.path.slice(f.path.lastIndexOf('/') + 1), meta });
  }
  for (const f of ingest.files) addEdge({ from: `dir:${parentDir(f.path)}`, to: `file:${f.path}`, kind: 'contains' });
  for (const f of parse.files.values()) for (const imp of f.imports) addEdge({ from: `file:${f.path}`, to: `file:${imp.to}`, kind: 'imports', weight: imp.weight });

  // Runtime: entry points.
  for (const e of analysis.entries) {
    addNode({ id: `entry:${e.path}`, kind: 'entry', label: `${e.kind}: ${e.path}`, meta: { path: e.path, kind: e.kind, reasons: e.reasons, score: e.score, ...(e.command ? { command: e.command } : {}) } });
    addEdge({ from: `entry:${e.path}`, to: `file:${e.path}`, kind: 'starts' });
  }

  // Docs.
  for (const d of analysis.docs) {
    addNode({ id: `doc:${d.path}`, kind: 'doc', label: scrubEmails(d.title), meta: { path: d.path } });
    for (const x of d.describes) addEdge({ from: `doc:${d.path}`, to: `${x.isDir ? 'dir' : 'file'}:${x.path}`, kind: 'describes', confidence: x.confidence });
  }

  // People: every file owner, the most active non-bot authors, and PR authors and reviewers.
  const owners = new Set<string>();
  for (const a of analysis.files.values()) for (const o of a.owners) owners.add(o);
  const ranked = [...analysis.persons.values()].filter((x) => !x.bot).sort((a, b) => b.commits - a.commits || a.id.localeCompare(b.id));
  const keepPerson = new Set<string>([...owners, ...ranked.slice(0, MAX_PERSONS).map((x) => x.id)]);
  for (const x of ranked) if (keepPerson.has(x.id)) addNode({ id: x.id, kind: 'person', label: scrubEmails(x.name), meta: { commits: x.commits } });
  const loginPerson = (login: string): string => {
    const id = `person:${personSlug(login)}`;
    const existing = nodeById.get(id);
    if (!existing) addNode({ id, kind: 'person', label: login, meta: { login } });
    else if (!existing.meta.login) existing.meta.login = login;
    return id;
  };

  // History: the most recent commits that touch kept files.
  const chosen = history.filter((c) => !c.bulk && c.files.some((f) => filePaths.has(f))).slice(0, p.commitLimit);
  const prByNumber = new Map(github.prs.map((x) => [x.number, x]));
  const ensureIssue = (n: number, extra?: { title?: string; state?: string }): string => {
    const id = `issue:${n}`;
    if (!nodeIds.has(id)) {
      addNode({ id, kind: 'issue', label: scrubEmails(extra?.title ?? `#${n}`), meta: { number: n, state: extra?.state?.toLowerCase() ?? 'unknown', ...(extra?.title ? {} : { stub: true }) } });
    }
    return id;
  };
  // Issues that merged PRs close come first, so commit links can reuse their titles.
  for (const pr of github.prs) for (const c of pr.closing) ensureIssue(c.number, c);
  for (const c of chosen) {
    const id = `commit:${sha7(c.sha)}`;
    if (nodeIds.has(id)) continue;
    addNode({ id, kind: 'commit', label: c.subject, meta: { date: c.date, ...(c.prRef ? { prNumber: c.prRef } : {}) } });
    if (!isBot(c.author)) addEdge({ from: `person:${personSlug(c.author)}`, to: id, kind: 'authored' });
    for (const f of c.files.filter((x) => filePaths.has(x)).slice(0, MAX_TOUCH_FILES)) addEdge({ from: id, to: `file:${f}`, kind: 'touches' });
    for (const n of c.fixes) {
      // "likely" from the message alone; "exact" when the PR it arrived with is confirmed to close it.
      const confirmed = c.prRef !== undefined && prByNumber.get(c.prRef)?.closing.some((x) => x.number === n);
      addEdge({ from: id, to: ensureIssue(n), kind: 'fixes', confidence: confirmed ? 'exact' : 'likely' });
    }
  }

  // Merged PRs from GraphQL.
  for (const pr of github.prs) {
    const id = `pr:${pr.number}`;
    addNode({ id, kind: 'pr', label: pr.title, meta: { number: pr.number, state: 'merged', ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}) } });
    if (pr.author && !isBot(pr.author)) addEdge({ from: loginPerson(pr.author), to: id, kind: 'authored' });
    for (const r of pr.reviewers) if (!isBot(r)) addEdge({ from: loginPerson(r), to: id, kind: 'reviewed' });
    if (p.withPrFiles) for (const f of pr.files.filter((x) => filePaths.has(x))) addEdge({ from: id, to: `file:${f}`, kind: 'touches' });
    for (const c of pr.closing) addEdge({ from: id, to: ensureIssue(c.number, c), kind: 'fixes', confidence: 'exact' });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    repo: ingest.repo,
    sha: ingest.sha,
    builtAt: p.builtAt,
    tier: parse.tier,
    truncated: p.truncated,
    commitWindow: history.length,
    nodes,
    edges,
  };
}

/** Shrink steps tried in order until the serialized snapshot fits the byte budget. */
export const LADDER = (maxCommits: number): { commitLimit: number; withSymbols: boolean; withPrFiles: boolean; note: string }[] => [
  { commitLimit: maxCommits, withSymbols: true, withPrFiles: true, note: '' },
  { commitLimit: Math.min(maxCommits, 200), withSymbols: true, withPrFiles: true, note: 'commit nodes cut to 200' },
  { commitLimit: Math.min(maxCommits, 100), withSymbols: true, withPrFiles: true, note: 'commit nodes cut to 100' },
  { commitLimit: Math.min(maxCommits, 50), withSymbols: false, withPrFiles: true, note: 'commit nodes cut to 50 and symbol lists dropped' },
  { commitLimit: 0, withSymbols: false, withPrFiles: false, note: 'commit nodes and PR file links dropped' },
];


export interface FitResult {
  snapshot: Snapshot;
  bytes: number;
  /** What was dropped to fit the byte budget, or '' when nothing was. */
  note: string;
  commitNodes: number;
}

/** Assemble with the shrink ladder until the serialized snapshot fits `maxBytes`; throws when even the smallest does not. */
export function fitSnapshot(params: Omit<AssembleParams, 'commitLimit' | 'withSymbols' | 'withPrFiles' | 'truncated'> & { truncated: boolean }, maxCommits: number, maxBytes: number): FitResult {
  let last: FitResult | undefined;
  for (const [i, step] of LADDER(maxCommits).entries()) {
    const snapshot = assemble({ ...params, commitLimit: step.commitLimit, withSymbols: step.withSymbols, withPrFiles: step.withPrFiles, truncated: params.truncated || i > 0 });
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    last = { snapshot, bytes, note: step.note, commitNodes: snapshot.nodes.filter((n) => n.kind === 'commit').length };
    if (bytes <= maxBytes) return last;
  }
  throw new Error(`Snapshot is ${((last?.bytes ?? 0) / 1048576).toFixed(2)} MB even after trimming.`);
}
