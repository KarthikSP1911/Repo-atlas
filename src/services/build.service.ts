import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  MAX_SNAPSHOT_BYTES,
  SCHEMA_VERSION,
  SnapshotSchema,
  snapshotId,
  type GEdge,
  type GNode,
  type Snapshot,
} from './snapshot.schema.js';
import { ingestRepo, DEFAULT_COMMIT_WINDOW, DEFAULT_MAX_FILES, type IngestResult } from './ingest.service.js';
import { parseFiles, type ParseResult } from './parse.service.js';
import { analyze, isDocPath, type Analysis } from './graph.service.js';
import {
  ApiBudget,
  fetchGithubData,
  isBot,
  personSlug,
  readHistory,
  type GithubData,
  type GraphqlFn,
  type HistoryCommit,
} from './link.service.js';
import type { IssuesFile } from './issues.schema.js';

/**
 * OFFLINE ONLY. Runs ingest, parse, link and graph, assembles a Snapshot (plus the open-issues
 * file), validates it and keeps it under the 3 MB budget. Used by `npm run precompute`.
 */

export interface BuildOptions {
  repo: string;
  /** Directory the clone is created in. It must not exist yet or be empty. */
  workDir: string;
  cloneUrl?: string;
  commitWindow?: number;
  maxFiles?: number;
  /** GitHub GraphQL client. Omit to skip PRs and issues (the snapshot then has no PR layer). */
  graphql?: GraphqlFn | null;
  budget?: ApiBudget;
  /** Most recent commits to keep as nodes (the rest still feed churn and owners). */
  maxCommitNodes?: number;
  /** Serialized size limit in bytes. Defaults to 95% of the 3 MB cap. */
  maxBytes?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface BuildReport {
  repo: string;
  snapshotId: string;
  sha: string;
  tier: 1 | 2;
  truncated: boolean;
  files: { tracked: number; kept: number; skipped: Record<string, number> };
  nodes: number;
  edges: number;
  bytes: number;
  commitsRead: number;
  commitNodes: number;
  prs: number;
  openIssues: number;
  parse: ParseResult['stats'];
  api: { calls: number; maxCalls: number; cost: number; remaining?: number; stoppedReason?: string; log: { name: string; cost: number; remaining: number }[] };
  warnings: string[];
  timingsMs: Record<string, number>;
}

export interface BuildResult {
  id: string;
  snapshot: Snapshot;
  issues: IssuesFile;
  report: BuildReport;
}

const EMPTY_GITHUB: GithubData = { description: null, primaryLanguage: null, defaultBranch: null, license: null, prs: [], issues: [], labelsQueried: [], limits: [] };

const MAX_TOUCH_FILES = 40;
const MAX_PERSONS = 200;
const sha7 = (sha: string): string => sha.slice(0, 7);
const parentDir = (x: string): string => (x.includes('/') ? x.slice(0, x.lastIndexOf('/')) : '.');

interface AssembleParams {
  ingest: IngestResult;
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
      description: analysis.project.description ?? github.description ?? undefined,
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
      if (parsed.doc) meta.doc = parsed.doc;
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
    addNode({ id: `doc:${d.path}`, kind: 'doc', label: d.title, meta: { path: d.path } });
    for (const x of d.describes) addEdge({ from: `doc:${d.path}`, to: `${x.isDir ? 'dir' : 'file'}:${x.path}`, kind: 'describes', confidence: x.confidence });
  }

  // People: every file owner, the most active non-bot authors, and PR authors and reviewers.
  const owners = new Set<string>();
  for (const a of analysis.files.values()) for (const o of a.owners) owners.add(o);
  const ranked = [...analysis.persons.values()].filter((x) => !x.bot).sort((a, b) => b.commits - a.commits || a.id.localeCompare(b.id));
  const keepPerson = new Set<string>([...owners, ...ranked.slice(0, MAX_PERSONS).map((x) => x.id)]);
  for (const x of ranked) if (keepPerson.has(x.id)) addNode({ id: x.id, kind: 'person', label: x.name, meta: { commits: x.commits } });
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
      addNode({ id, kind: 'issue', label: extra?.title ?? `#${n}`, meta: { number: n, state: extra?.state?.toLowerCase() ?? 'unknown', ...(extra?.title ? {} : { stub: true }) } });
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
const LADDER = (maxCommits: number): { commitLimit: number; withSymbols: boolean; withPrFiles: boolean; note: string }[] => [
  { commitLimit: maxCommits, withSymbols: true, withPrFiles: true, note: '' },
  { commitLimit: Math.min(maxCommits, 200), withSymbols: true, withPrFiles: true, note: 'commit nodes cut to 200' },
  { commitLimit: Math.min(maxCommits, 100), withSymbols: true, withPrFiles: true, note: 'commit nodes cut to 100' },
  { commitLimit: Math.min(maxCommits, 50), withSymbols: false, withPrFiles: true, note: 'commit nodes cut to 50 and symbol lists dropped' },
  { commitLimit: 0, withSymbols: false, withPrFiles: false, note: 'commit nodes and PR file links dropped' },
];

async function readTexts(dir: string, files: IngestResult['files']): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  const wanted = (p: string): boolean => /(^|\/)(package\.json|pyproject\.toml|requirements[\w.-]*\.txt|go\.mod|Cargo\.toml)$/.test(p) || /^readme(\.[a-z]+)?$/i.test(p);
  const docs = files.map((f) => f.path).filter((p) => isDocPath(p) && !wanted(p)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, 40);
  for (const p of [...files.map((f) => f.path).filter(wanted), ...docs]) {
    try {
      const text = await fs.readFile(path.join(dir, p), 'utf8');
      texts.set(p, text.slice(0, 100_000));
    } catch {
      // unreadable: skip
    }
  }
  return texts;
}

export async function buildSnapshot(opts: BuildOptions): Promise<BuildResult> {
  const log = opts.log ?? (() => undefined);
  const now = (opts.now ?? (() => new Date()))();
  const timings: Record<string, number> = {};
  const time = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - t0;
    }
  };
  const warnings: string[] = [];

  log(`clone ${opts.repo}`);
  const ingest = await time('clone', () =>
    ingestRepo({ repo: opts.repo, dir: opts.workDir, cloneUrl: opts.cloneUrl, commitWindow: opts.commitWindow ?? DEFAULT_COMMIT_WINDOW, maxFiles: opts.maxFiles ?? DEFAULT_MAX_FILES }),
  );
  log(`kept ${ingest.files.length} of ${ingest.totalTracked} tracked files at ${sha7(ingest.sha)}${ingest.truncated ? ' (truncated)' : ''}`);

  const parse = await time('parse', () => parseFiles(ingest.dir, ingest.files));
  log(`parsed: ${parse.stats.jsTsFiles} JS/TS, ${parse.stats.pyFiles} Python, ${parse.stats.importEdges} import edges, tier ${parse.tier}`);

  const history = await time('history', () => readHistory(ingest.dir, opts.repo, opts.commitWindow ?? DEFAULT_COMMIT_WINDOW));
  const texts = await time('texts', () => readTexts(ingest.dir, ingest.files));

  const budget = opts.budget ?? new ApiBudget();
  let github = EMPTY_GITHUB;
  if (opts.graphql) {
    github = await time('github', () => fetchGithubData(opts.graphql!, opts.repo, budget));
    log(`github: ${github.prs.length} merged PRs, ${github.issues.length} open issues, ${budget.calls} calls`);
  } else {
    github = { ...EMPTY_GITHUB, limits: ['GitHub data was not fetched (no token), so there are no PR links or open issues.'] };
    warnings.push('No GitHub token: PR layer and open issues are empty.');
  }
  warnings.push(...github.limits);

  const analysis = analyze({ files: parse.files, commits: history, texts, lockfiles: ingest.lockfiles });
  const builtAt = now.toISOString();
  const maxBytes = opts.maxBytes ?? Math.floor(MAX_SNAPSHOT_BYTES * 0.95);

  let snapshot: Snapshot | undefined;
  let bytes = 0;
  let trimmed = '';
  let commitNodes = 0;
  for (const [i, step] of LADDER(opts.maxCommitNodes ?? 400).entries()) {
    const candidate = assemble({ ingest, parse, analysis, history, github, builtAt, commitLimit: step.commitLimit, withSymbols: step.withSymbols, withPrFiles: step.withPrFiles, truncated: ingest.truncated || i > 0 });
    bytes = Buffer.byteLength(JSON.stringify(candidate));
    snapshot = candidate;
    trimmed = step.note;
    commitNodes = candidate.nodes.filter((n) => n.kind === 'commit').length;
    if (bytes <= maxBytes) break;
  }
  if (!snapshot || bytes > maxBytes) {
    throw new Error(`Snapshot is ${(bytes / 1048576).toFixed(2)} MB even after trimming; lower --max-files (now ${opts.maxFiles ?? DEFAULT_MAX_FILES}).`);
  }
  if (trimmed) warnings.push(`Size budget: ${trimmed}.`);
  if (ingest.truncated) warnings.push(`File cap: kept ${ingest.files.length} files and left out ${ingest.skipped['over-file-cap'] ?? 0} eligible ones; this is a partial graph.`);

  const checked = SnapshotSchema.safeParse(snapshot);
  if (!checked.success) {
    const first = checked.error.issues.slice(0, 5).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ');
    throw new Error(`Built snapshot failed validation (${checked.error.issues.length} issues): ${first}`);
  }

  const id = snapshotId(snapshot.repo, snapshot.sha);
  const issues: IssuesFile = {
    schemaVersion: 1,
    repo: snapshot.repo,
    snapshotId: id,
    fetchedAt: builtAt,
    labelsQueried: github.labelsQueried,
    limits: github.limits,
    issues: github.issues,
  };
  const report: BuildReport = {
    repo: snapshot.repo,
    snapshotId: id,
    sha: snapshot.sha,
    tier: snapshot.tier,
    truncated: snapshot.truncated,
    files: { tracked: ingest.totalTracked, kept: ingest.files.length, skipped: ingest.skipped },
    nodes: snapshot.nodes.length,
    edges: snapshot.edges.length,
    bytes,
    commitsRead: history.length,
    commitNodes,
    prs: github.prs.length,
    openIssues: github.issues.length,
    parse: parse.stats,
    api: { calls: budget.calls, maxCalls: budget.maxCalls, cost: budget.cost, remaining: budget.remaining, stoppedReason: budget.stoppedReason, log: budget.log },
    warnings,
    timingsMs: timings,
  };
  return { id, snapshot, issues, report };
}
