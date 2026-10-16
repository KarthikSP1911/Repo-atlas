import { graphql } from '@octokit/graphql';
import type { OpenIssue } from './issues.schema.js';
import { scrubEmails, cleanAuthorName } from './privacy.js';
import { ISSUES_QUERY, LABELS_QUERY, PR_QUERY, BEGINNER_LABEL, mapIssue, mapPr, type GraphqlFn, type PrData } from './github.graphql.js';

export { scrubEmails, cleanAuthorName, BEGINNER_LABEL, mapIssue, mapPr };
export type { GraphqlFn, PrData };
import { gitClient } from './ingest.service.js';

/**
 * OFFLINE ONLY. History and people from `git log --name-only` (never `--numstat`, which would
 * download blobs), plus one budgeted GraphQL pass for merged PRs and open issues.
 */

// --- History ---------------------------------------------------------------

export interface HistoryCommit {
  sha: string;
  subject: string;
  /** ISO 8601 author date. */
  date: string;
  /** Git author NAME (never the email address). */
  author: string;
  files: string[];
  /** `(#N)` in the message: usually the squash-merged PR number. Link confidence: likely. */
  prRef?: number;
  /** `Fixes #N` style references. Link confidence: likely until a PR upgrades it. */
  fixes: number[];
  /** Touches more than BULK_FILES files (renames, formatting); skipped when linking files. */
  bulk: boolean;
}

export const BULK_FILES = 40;

const FIX_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gi;

export function extractRefs(message: string, repo: string): { prRef?: number; fixes: number[] } {
  const subject = message.split('\n', 1)[0];
  const pr = /\(#(\d+)\)/.exec(subject) ?? /^Merge pull request #(\d+)/.exec(subject);
  const fixes = new Set<number>();
  for (const m of message.matchAll(FIX_RE)) {
    if (m[1] && m[1].toLowerCase() !== repo.toLowerCase()) continue; // other repo
    fixes.add(Number(m[2]));
  }
  return { prRef: pr ? Number(pr[1]) : undefined, fixes: [...fixes].sort((a, b) => a - b) };
}

/** Parse the output of the `git log` format used by `readHistory`. */
export function parseLog(raw: string, repo: string): HistoryCommit[] {
  const out: HistoryCommit[] = [];
  for (const rec of raw.split('\x1e')) {
    if (!rec.trim()) continue;
    const [head, after = ''] = rec.split('\x1d');
    const [sha, author, date, subject, body = ''] = head.split('\x1f');
    if (!sha || !/^[0-9a-f]{40}$/.test(sha.trim())) continue;
    const files = after.split('\n').map((l) => l.trim()).filter(Boolean);
    const refs = extractRefs(`${subject}\n${body}`, repo);
    out.push({
      sha: sha.trim(),
      subject: scrubEmails(subject).slice(0, 160),
      date,
      author: cleanAuthorName(author),
      files,
      prRef: refs.prRef,
      fixes: refs.fixes,
      bulk: files.length > BULK_FILES,
    });
  }
  return out;
}

export async function readHistory(dir: string, repo: string, window: number): Promise<HistoryCommit[]> {
  const raw = await gitClient(dir).raw([
    '-c', 'core.quotepath=false',
    'log', '-n', String(window), '--name-only',
    '--pretty=format:%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1d',
  ]);
  return parseLog(raw, repo);
}

export function isBot(name: string): boolean {
  return /\[bot\]$|^dependabot|^renovate|^github-actions|^greenkeeper|^pre-commit-ci/i.test(name);
}

export function personSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unknown';
}

// --- GitHub GraphQL (budgeted) ----------------------------------------------

export function makeGraphql(token: string): GraphqlFn {
  const client = graphql.defaults({ headers: { authorization: `token ${token}`, 'user-agent': 'repoatlas-precompute' } });
  return (query, variables) => client(query, variables);
}

/** Remove secrets from an error message before it is logged or stored. */
export function sanitizeError(e: unknown, secrets: string[]): string {
  let msg = e instanceof Error ? e.message : String(e);
  for (const s of secrets) if (s) msg = msg.split(s).join('[redacted]');
  return msg.replace(/(token|bearer)\s+[A-Za-z0-9_\-.]{20,}/gi, '$1 [redacted]').slice(0, 400);
}

export class BudgetStop extends Error {}

/** Per-run limit on GitHub calls, with the rate-limit fields GitHub returns. */
export class ApiBudget {
  calls = 0;
  cost = 0;
  remaining: number | undefined;
  resetAt: string | undefined;
  readonly log: { name: string; cost: number; remaining: number }[] = [];
  stoppedReason: string | undefined;

  constructor(readonly maxCalls = 30, readonly minRemaining = 100) {}

  async run(name: string, gql: GraphqlFn, query: string, variables: Record<string, unknown>): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (this.calls >= this.maxCalls) throw new BudgetStop(`call budget of ${this.maxCalls} reached before ${name}`);
    if (this.remaining !== undefined && this.remaining < this.minRemaining) {
      throw new BudgetStop(`only ${this.remaining} GraphQL points remain (reset ${this.resetAt}); stopped before ${name}`);
    }
    this.calls++;
    const res = await gql(query, variables);
    const rl = res?.rateLimit as { cost: number; remaining: number; resetAt: string } | undefined;
    if (rl) {
      this.cost += rl.cost;
      this.remaining = rl.remaining;
      this.resetAt = rl.resetAt;
      this.log.push({ name, cost: rl.cost, remaining: rl.remaining });
    }
    return res;
  }
}

export interface GithubData {
  description: string | null;
  primaryLanguage: string | null;
  defaultBranch: string | null;
  license: string | null;
  prs: PrData[];
  issues: OpenIssue[];
  labelsQueried: string[];
  /** Human-readable notes about partial data. */
  limits: string[];
}

export interface GithubFetchOptions {
  prPages?: number;
  prPageSize?: number;
  issuePages?: number;
  issuePageSize?: number;
  maxIssues?: number;
}

/** Roughly 5 to 7 calls: 1-2 PR pages, 1 label lookup, 1-2 labelled issue pages, 1 recent issue page. */
export async function fetchGithubData(
  gql: GraphqlFn,
  repo: string,
  budget: ApiBudget,
  opts: GithubFetchOptions = {},
): Promise<GithubData> {
  const [owner, name] = repo.split('/');
  const prPages = opts.prPages ?? 2;
  const prSize = opts.prPageSize ?? 50;
  const issuePages = opts.issuePages ?? 2;
  const issueSize = opts.issuePageSize ?? 50;
  const maxIssues = opts.maxIssues ?? 150;
  const data: GithubData = { description: null, primaryLanguage: null, defaultBranch: null, license: null, prs: [], issues: [], labelsQueried: [], limits: [] };

  try {
    let after: string | null = null;
    for (let page = 0; page < prPages; page++) {
      const res = await budget.run(`prs#${page + 1}`, gql, PR_QUERY, { owner, name, first: prSize, after });
      const r = res.repository;
      if (page === 0) {
        data.description = r.description ?? null;
        data.primaryLanguage = r.primaryLanguage?.name ?? null;
        data.defaultBranch = r.defaultBranchRef?.name ?? null;
        data.license = r.licenseInfo?.spdxId ?? null;
      }
      data.prs.push(...r.pullRequests.nodes.map(mapPr));
      if (!r.pullRequests.pageInfo.hasNextPage) break;
      after = r.pullRequests.pageInfo.endCursor;
      if (page === prPages - 1) data.limits.push(`Merged PRs: only the latest ${data.prs.length} were read.`);
    }

    const lab = (await budget.run('labels', gql, LABELS_QUERY, { owner, name })).repository;
    const names = new Set<string>();
    // GitHub's label search is fuzzy (a "help wanted" search can return "help output"), so keep real matches only.
    for (const key of ['gfi', 'hw', 'ft']) for (const l of lab[key]?.nodes ?? []) if (BEGINNER_LABEL.test(String(l.name))) names.add(l.name);
    data.labelsQueried = [...names];

    const byNumber = new Map<number, OpenIssue>();
    const pull = async (label: string, labels: string[] | null, pages: number): Promise<void> => {
      let cursor: string | null = null;
      for (let page = 0; page < pages && byNumber.size < maxIssues; page++) {
        const res = await budget.run(`issues:${label}#${page + 1}`, gql, ISSUES_QUERY, { owner, name, first: issueSize, after: cursor, labels });
        const conn = res.repository.issues;
        for (const n of conn.nodes) if (!byNumber.has(n.number) && byNumber.size < maxIssues) byNumber.set(n.number, mapIssue(n));
        if (!conn.pageInfo.hasNextPage) return;
        cursor = conn.pageInfo.endCursor;
      }
      data.limits.push(`Open issues (${label}): not every page was read.`);
    };
    if (data.labelsQueried.length) await pull('labelled', data.labelsQueried, issuePages);
    else data.limits.push('No "good first issue" / "help wanted" style labels exist in this repo.');
    await pull('recent', null, 1);
    data.issues = [...byNumber.values()];
  } catch (e) {
    if (e instanceof BudgetStop) {
      budget.stoppedReason = e.message;
      data.limits.push(`Stopped early: ${e.message}.`);
    } else {
      throw e;
    }
  }
  return data;
}
