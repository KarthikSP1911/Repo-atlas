import { createHash } from 'node:crypto';
import { analyze, isDocPath } from '../graph.service.js';
import { fitSnapshot } from '../assemble.js';
import { DEFAULT_MAX_FILES, LOCKFILES, MAX_FILE_BYTES, keepPriority, skipReason } from '../ingest.common.js';
import { fetchGraphql } from '../github.graphql.js';
import { ApiBudget, fetchGithubData, sanitizeError, type GithubData } from '../github.fetch.js';
import { IssuesFileSchema, type IssuesFile } from '../issues.schema.js';
import { MAX_SNAPSHOT_BYTES, SnapshotSchema, snapshotId, type Snapshot } from '../snapshot.schema.js';
import type { HistoryCommit } from '../people.js';
import { DEFAULT_TARBALL_LIMITS, LiveBuildError, readTarball, type TarballLimits } from './fetch-tarball.js';
import { fetchCommits, fetchIssuesRest, fetchRepoMeta, type RepoMeta } from './github-rest.js';
import { parseContentsLight } from './parse-light.js';
import type { RepoSpec } from './repo-spec.js';
import type { TarHandlers } from './tar.js';

/**
 * Builds a snapshot for any public GitHub repo while the server runs: no git binary, no
 * clone. The repo arrives as one streamed tar.gz (files and contents), a few GitHub calls add
 * description, commits and issues, and the same analysis and assembly code as the offline
 * precompute produces the snapshot. Every limit stops the work early and says so in the
 * snapshot's notes instead of failing.
 */

export interface LiveBuildOptions {
  fetchFn?: typeof fetch;
  /** Read-only GitHub token (optional). Only ever sent to api.github.com. */
  token?: string;
  now?: () => Date;
  /** Wall-clock budget for the whole build, in ms (default 40 s, or LIVE_BUILD_TIMEOUT_MS). */
  totalMs?: number;
  limits?: Partial<Omit<TarballLimits, 'deadlineAt'>>;
  maxFiles?: number;
  log?: (msg: string) => void;
}

export interface LiveBuildResult {
  id: string;
  snapshot: Snapshot;
  issues: IssuesFile;
  report: {
    repo: string;
    snapshotId: string;
    tier: 1 | 2;
    truncated: boolean;
    files: { seen: number; kept: number; skipped: Record<string, number> };
    commits: number;
    openIssues: number;
    prs: number;
    bytes: number;
    tarball: { compressedBytes: number; uncompressedBytes: number };
    timingsMs: { total: number; tarball: number; github: number };
    notes: string[];
  };
}

const MAX_BUFFER_BYTES = 30 * 1024 * 1024;
const MAX_CODE_BYTES = 400 * 1024;
const MAX_DOC_BYTES = 100 * 1024;
const MAX_DOCS_BUFFERED = 80;
const CODE_OR_CONFIG = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go)$|(^|\/)(package|tsconfig|jsconfig)\.json$/;
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[\w.-]*\.txt|go\.mod|Cargo\.toml)$/;
const README = /^readme(\.[a-z]+)?$/i;
const sha7 = (sha: string): string => sha.slice(0, 7);
const clip = (s: string, n = 380): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface GithubSide {
  meta: RepoMeta | null;
  github: GithubData;
  commits: HistoryCommit[];
  notes: string[];
}

/** Everything that comes from the GitHub API. Never throws: failures become notes. */
async function fetchGithubSide(spec: RepoSpec, o: LiveBuildOptions, deadlineAt: number): Promise<GithubSide> {
  const rest = { token: o.token, fetchFn: o.fetchFn };
  const notes: string[] = [];
  const empty: GithubData = { description: null, primaryLanguage: null, defaultBranch: null, license: null, prs: [], issues: [], labelsQueried: [], limits: [] };

  const graphqlPart = async (): Promise<GithubData | null> => {
    if (!o.token) return null;
    try {
      const gql = fetchGraphql(o.token, o.fetchFn ?? fetch);
      return await fetchGithubData(gql, spec.repo, new ApiBudget(12));
    } catch (e) {
      notes.push(`The fuller GitHub query failed (${sanitizeError(e, [o.token])}); the basic one was used instead.`);
      return null;
    }
  };
  const restPart = async (): Promise<{ meta: RepoMeta | null; issues: Awaited<ReturnType<typeof fetchIssuesRest>> }> => {
    const [meta, issues] = await Promise.all([fetchRepoMeta(spec, rest), fetchIssuesRest(spec, rest)]);
    return { meta: meta.ok ? meta.data : null, issues };
  };

  const [gql, commitsRes] = await Promise.all([graphqlPart(), fetchCommits(spec, { ...rest, deadlineAt })]);
  notes.push(...commitsRes.notes);

  if (gql) {
    notes.push(...gql.limits);
    return { meta: null, github: gql, commits: commitsRes.commits, notes };
  }
  const r = await restPart();
  notes.push(...r.issues.notes);
  const github: GithubData = {
    ...empty,
    description: r.meta?.description ?? null,
    primaryLanguage: r.meta?.primaryLanguage ?? null,
    defaultBranch: r.meta?.defaultBranch ?? null,
    license: r.meta?.license ?? null,
    issues: r.issues.issues,
    limits: [...r.issues.notes],
  };
  if (!o.token) github.limits.push('Merged pull requests were not read (needs a GitHub token on the server), so there are no PR links.');
  return { meta: r.meta, github, commits: commitsRes.commits, notes };
}

export async function buildLiveSnapshot(spec: RepoSpec, o: LiveBuildOptions = {}): Promise<LiveBuildResult> {
  const now = o.now ?? (() => new Date());
  const t0 = Date.now();
  const totalMs = o.totalMs ?? (Number(process.env.LIVE_BUILD_TIMEOUT_MS) > 0 ? Number(process.env.LIVE_BUILD_TIMEOUT_MS) : 40_000);
  const limits: TarballLimits = { ...DEFAULT_TARBALL_LIMITS, ...o.limits, deadlineAt: t0 + Math.floor(totalMs * 0.65) };
  const maxFiles = o.maxFiles ?? DEFAULT_MAX_FILES;

  const kept: { path: string; size: number }[] = [];
  const contents = new Map<string, string>();
  const lineCounts = new Map<string, number>();
  const skipped: Record<string, number> = {};
  const lockfiles: string[] = [];
  let bufferedBytes = 0;
  let docsBuffered = 0;
  const bump = (k: string): void => {
    skipped[k] = (skipped[k] ?? 0) + 1;
  };

  const handlers: TarHandlers = {
    decide: ({ path: p, size }) => {
      const base = p.slice(p.lastIndexOf('/') + 1);
      if (LOCKFILES.has(base) && !lockfiles.includes(base)) lockfiles.push(base);
      const reason = skipReason(p);
      if (reason) {
        bump(reason);
        return 'skip';
      }
      if (size > MAX_FILE_BYTES) {
        bump('too-large');
        return 'skip';
      }
      const isDoc = isDocPath(p) || MANIFEST.test(p) || README.test(p);
      const wants = (CODE_OR_CONFIG.test(p) && size <= MAX_CODE_BYTES) || (isDoc && size <= MAX_DOC_BYTES && (MANIFEST.test(p) || README.test(p) || docsBuffered < MAX_DOCS_BUFFERED));
      if (wants && bufferedBytes + size <= MAX_BUFFER_BYTES) {
        bufferedBytes += size;
        if (isDoc && !MANIFEST.test(p) && !README.test(p)) docsBuffered++;
        return 'buffer';
      }
      return 'count';
    },
    onFile: (f) => {
      if (f.binary) {
        bump('binary');
        return;
      }
      kept.push({ path: f.path, size: f.size });
      if (f.text !== undefined) contents.set(f.path, f.text);
      else if (f.lines !== undefined) lineCounts.set(f.path, f.lines);
    },
  };

  o.log?.(`live build ${spec.repo}`);
  const ghDeadline = t0 + Math.floor(totalMs * 0.85);
  const tTar = Date.now();
  const githubP = fetchGithubSide(spec, o, ghDeadline);
  let tar;
  try {
    tar = await readTarball(spec, handlers, limits, o.fetchFn ?? fetch, o.token);
  } catch (e) {
    void githubP; // never rejects; its result is simply dropped
    throw e;
  }
  const tarMs = Date.now() - tTar;
  const side = await githubP;
  const githubMs = Date.now() - t0 - tarMs > 0 ? Date.now() - t0 - tarMs : 0;

  if (kept.length === 0) throw new LiveBuildError('failed', `${spec.repo} has no readable source files (an empty repo, or only binary and ignored files).`);

  // File cap: same rule as the offline engine (shallow, code, non-test paths win).
  let capped = false;
  let files = kept;
  if (kept.length > maxFiles) {
    capped = true;
    files = [...kept].sort((a, b) => keepPriority(a.path) - keepPriority(b.path) || a.path.localeCompare(b.path)).slice(0, maxFiles);
    skipped['over-file-cap'] = kept.length - maxFiles;
  }
  files = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const allPaths = new Set(files.map((f) => f.path));
  for (const p of [...contents.keys()]) if (!allPaths.has(p)) contents.delete(p);

  const parse = parseContentsLight(allPaths, contents, lineCounts);

  // Texts for analysis: manifests, the readme and up to 40 docs, shallowest first.
  const texts = new Map<string, string>();
  for (const p of allPaths) {
    const t = contents.get(p);
    if (t !== undefined && (MANIFEST.test(p) || README.test(p))) texts.set(p, t.slice(0, 100_000));
  }
  const docPaths = [...allPaths].filter((p) => isDocPath(p) && !texts.has(p) && contents.has(p)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, 40);
  for (const p of docPaths) texts.set(p, contents.get(p)!.slice(0, 100_000));

  const repo = side.meta?.fullName ?? spec.repo;
  const history = side.commits;
  const analysis = analyze({ files: parse.files, commits: history, texts, lockfiles });

  const notes: string[] = [];
  let sha = tar.sha;
  if (!sha) {
    sha = history[0]?.sha ?? createHash('sha256').update([...allPaths].join('\n')).digest('hex').slice(0, 40);
    notes.push('GitHub did not include the commit id in the archive, so the snapshot id is derived from the latest commit seen (or the file list).');
  }
  const builtAt = now().toISOString();
  notes.unshift(`Built on demand from GitHub's archive of the default branch at commit ${sha7(sha)}, not from a precomputed snapshot.`);
  if (parse.tier === 2) notes.push('Imports were found with a text scan rather than a compiler, so the import graph is approximate: path aliases and unusual syntax can be missed.');
  if (tar.truncated) notes.push(`Only part of the repo was read because ${tar.truncatedReason}; files that come later in the archive are missing.`);
  if (capped) notes.push(`File cap: kept ${files.length} files and left out ${skipped['over-file-cap']} eligible ones; this is a partial graph.`);
  notes.push(...side.notes);

  const truncated = tar.truncated || capped;
  const fit = fitSnapshot({ ingest: { repo, sha, defaultBranch: side.meta?.defaultBranch ?? 'HEAD', files }, parse, analysis, history, github: side.github, builtAt, truncated }, 400, Math.floor(MAX_SNAPSHOT_BYTES * 0.95));
  if (fit.note) notes.push(`Size budget: ${fit.note}.`);

  const snapshot: Snapshot = { ...fit.snapshot, source: { kind: 'live', notes: [...new Set(notes)].slice(0, 14).map((n) => clip(n)) } };
  const checked = SnapshotSchema.safeParse(snapshot);
  if (!checked.success) {
    const first = checked.error.issues.slice(0, 3).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ');
    throw new LiveBuildError('failed', `The built graph for ${spec.repo} failed its own validation (${first}).`);
  }

  const id = snapshotId(snapshot.repo, snapshot.sha);
  let issues: IssuesFile = { schemaVersion: 1, repo: snapshot.repo, snapshotId: id, fetchedAt: builtAt, labelsQueried: side.github.labelsQueried, limits: side.github.limits.map((n) => clip(n)), issues: side.github.issues };
  const issuesChecked = IssuesFileSchema.safeParse(issues);
  if (!issuesChecked.success) issues = { ...issues, issues: [], limits: [...issues.limits, 'Open issues were dropped because the data from GitHub did not fit the expected shape.'] };

  return {
    id,
    snapshot: checked.data,
    issues,
    report: {
      repo: snapshot.repo,
      snapshotId: id,
      tier: snapshot.tier,
      truncated: snapshot.truncated,
      files: { seen: tar.filesSeen, kept: files.length, skipped },
      commits: history.length,
      openIssues: issues.issues.length,
      prs: side.github.prs.length,
      bytes: fit.bytes,
      tarball: { compressedBytes: tar.compressedBytes, uncompressedBytes: tar.uncompressedBytes },
      timingsMs: { total: Date.now() - t0, tarball: tarMs, github: githubMs },
      notes: checked.data.source?.notes ?? [],
    },
  };
}
