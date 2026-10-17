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
import { analyze, isDocPath } from './graph.service.js';
import { assemble, LADDER } from './assemble.js';
import {
  ApiBudget,
  fetchGithubData,
  isBot,
  personSlug,
  scrubEmails,
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

const sha7 = (sha: string): string => sha.slice(0, 7);

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
