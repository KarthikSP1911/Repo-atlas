import { CANDIDATES, FIRST_CHANGE } from '../config/weights.js';
import { ISSUES_QUERY, mapIssue, type GraphqlFn } from './github.graphql.js';
import { claimEvidence, clarityOf, daysBetween, hasLabel } from './issues.service.js';
import type { IssuesFile, OpenIssue } from './issues.schema.js';
import type { Profile } from './profile.types.js';

/**
 * Issue matching for Part B. Hard filters drop an issue that fails any of them; soft boosts only
 * reorder what is left. Every returned issue carries the reason it passed and the evidence behind
 * the "likely unclaimed" label. All issue text is untrusted data: it is measured here, never obeyed.
 */

export interface Candidate {
  number: number;
  title: string;
  url: string;
  labels: string[];
  /** Why it passed each hard filter, in plain words. */
  reasonsPassed: string[];
  /** Always "likely unclaimed": the evidence can be wrong (someone may be working on it off GitHub). */
  claim: { label: 'likely unclaimed'; evidence: string[] };
  clarity: { score: number; signals: string[] };
  freshness: { score: number; daysSinceActivity: number };
  boosts: { labels: string[]; maintainerWanted: boolean; maintainerEvidence?: string };
  /** 0..1 ordering score (clarity, freshness, beginner label, maintainer wants it); not a prediction of difficulty. */
  rankScore: number;
  commentCount: number;
  updatedAt: string;
  /** Present when the title or labels mention a language the contributor did not list. */
  languageNote?: string;
}

export type ExcludeReason = 'claimed' | 'maybeFixed' | 'stale' | 'blocked' | 'unclear';

export interface CandidateResult {
  considered: number;
  candidates: Candidate[];
  excluded: Record<ExcludeReason, number>;
  /** A few excluded issues with the reason, so the exclusion is checkable. */
  excludedExamples: { number: number; title: string; reason: ExcludeReason; detail: string }[];
}

const MAINTAINER = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const WANTED = /(contributions? (are )?welcome|prs? (are )?welcome|pull requests? (are )?welcome|happy to (review|accept|merge|help)|feel free to (open|submit|send|try|pick)|we('d| would) (welcome|accept|love)|good (first )?issue|help wanted|up for grabs|would accept a pr)/i;

const LANGUAGE_WORDS: Record<string, string> = {
  typescript: 'ts', javascript: 'js', python: 'py', golang: 'go', rust: 'rust', java: 'java', kotlin: 'kotlin', ruby: 'ruby', php: 'php', swift: 'swift', 'c++': 'cpp', 'c#': 'csharp',
};

function languageNote(issue: OpenIssue, profile: Profile | undefined): string | undefined {
  if (!profile || profile.languages.length === 0) return undefined;
  const text = `${issue.title} ${issue.labels.join(' ')}`.toLowerCase();
  const mentioned = Object.entries(LANGUAGE_WORDS).filter(([word]) => new RegExp(`(^|[^a-z])${word.replace(/[+#]/g, '\\$&')}([^a-z]|$)`).test(text)).map(([, id]) => id);
  const outside = mentioned.filter((id) => !profile.languages.includes(id));
  return outside.length && !mentioned.some((id) => profile.languages.includes(id)) ? `mentions ${outside.join(', ')}, which is not in your languages` : undefined;
}

export function freshnessOf(updatedAt: string, now: string): { score: number; days: number } {
  const days = daysBetween(updatedAt, now);
  return { score: Number((0.5 ** (days / FIRST_CHANGE.freshnessHalfLifeDays)).toFixed(3)), days: Math.round(days) };
}

export function findCandidates(file: Pick<IssuesFile, 'issues' | 'fetchedAt'>, profile: Profile | undefined, limit = 10): CandidateResult {
  const now = file.fetchedAt;
  const excluded: Record<ExcludeReason, number> = { claimed: 0, maybeFixed: 0, stale: 0, blocked: 0, unclear: 0 };
  const examples: CandidateResult['excludedExamples'] = [];
  const drop = (i: OpenIssue, reason: ExcludeReason, detail: string): void => {
    excluded[reason]++;
    if (examples.length < 12 && examples.filter((e) => e.reason === reason).length < 3) examples.push({ number: i.number, title: i.title.slice(0, 120), reason, detail });
  };

  const out: Candidate[] = [];
  for (const issue of file.issues) {
    const blocked = hasLabel(issue, CANDIDATES.blockedLabels);
    if (blocked.length) {
      drop(issue, 'blocked', `label "${blocked[0]}"`);
      continue;
    }
    const age = daysBetween(issue.updatedAt, now);
    if (age > CANDIDATES.staleAfterDays) {
      drop(issue, 'stale', `no activity for ${Math.round(age)} days`);
      continue;
    }
    const claim = claimEvidence(issue, now);
    if (claim.claimed) {
      drop(issue, 'claimed', claim.evidence[0]);
      continue;
    }
    if (claim.maybeFixed) {
      drop(issue, 'maybeFixed', claim.evidence[0]);
      continue;
    }
    const clarity = clarityOf(issue);
    if (!clarity.clearEnough) {
      drop(issue, 'unclear', clarity.signals.length ? `only: ${clarity.signals.join(', ')}` : 'body is empty or too short');
      continue;
    }

    const labels = hasLabel(issue, CANDIDATES.boostLabels);
    const wantedComment = issue.comments.find((c) => MAINTAINER.has(c.association) && WANTED.test(c.body));
    const fresh = freshnessOf(issue.updatedAt, now);
    const w = CANDIDATES.rank;
    const rankScore = Number((w.clarity * clarity.score + w.freshness * fresh.score + w.beginnerLabel * (labels.length ? 1 : 0) + w.maintainerWanted * (wantedComment ? 1 : 0)).toFixed(3));
    out.push({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      labels: issue.labels,
      reasonsPassed: [
        'open issue (not a pull request)',
        `not claimed: ${claim.evidence[0]}`,
        `active ${Math.round(age)} days ago (limit ${CANDIDATES.staleAfterDays})`,
        'no blocking label',
        `clear enough: ${clarity.signals.join(', ')}`,
      ],
      claim: { label: 'likely unclaimed', evidence: claim.evidence },
      clarity: { score: clarity.score, signals: clarity.signals },
      freshness: { score: fresh.score, daysSinceActivity: fresh.days },
      boosts: { labels, maintainerWanted: Boolean(wantedComment), ...(wantedComment ? { maintainerEvidence: `a ${wantedComment.association.toLowerCase()} commented on ${wantedComment.createdAt.slice(0, 10)}` } : {}) },
      rankScore,
      commentCount: issue.commentCount,
      updatedAt: issue.updatedAt,
      languageNote: languageNote(issue, profile),
    });
  }
  out.sort((a, b) => b.rankScore - a.rankScore || b.number - a.number);
  return { considered: file.issues.length, candidates: out.slice(0, Math.max(1, limit)), excluded, excludedExamples: examples };
}

// --- Live refresh (RUNTIME_MODE=live only) ---------------------------------------

export interface RefreshState {
  cache: Map<string, { at: number; issues: OpenIssue[]; fetchedAt: string }>;
  calls: { at: number }[];
}

export function newRefreshState(): RefreshState {
  return { cache: new Map(), calls: [] };
}

export interface RefreshOutcome {
  issues: OpenIssue[];
  fetchedAt: string;
  source: 'snapshot-file' | 'live-refresh' | 'live-cache';
  note?: string;
}

/**
 * Re-fetch open issues, at most once per cache window and within a per-hour call budget.
 * On any failure the precomputed file is served unchanged with an "as of" note.
 */
export async function refreshIssues(
  repo: string,
  file: IssuesFile,
  gql: GraphqlFn,
  state: RefreshState,
  nowMs = Date.now(),
): Promise<RefreshOutcome> {
  const fallback = (note: string): RefreshOutcome => ({ issues: file.issues, fetchedAt: file.fetchedAt, source: 'snapshot-file', note });
  const hit = state.cache.get(repo);
  if (hit && nowMs - hit.at < CANDIDATES.refreshCacheMinutes * 60_000) return { issues: hit.issues, fetchedAt: hit.fetchedAt, source: 'live-cache', note: `Served from a ${CANDIDATES.refreshCacheMinutes}-minute cache.` };

  state.calls = state.calls.filter((c) => nowMs - c.at < 3_600_000);
  if (state.calls.length + 2 > CANDIDATES.refreshCallsPerHour) return fallback(`Refresh budget used up (${CANDIDATES.refreshCallsPerHour} calls per hour); serving the issues as of ${file.fetchedAt}.`);

  const [owner, name] = repo.split('/');
  const byNumber = new Map<number, OpenIssue>();
  try {
    const pulls: { labels: string[] | null }[] = [{ labels: file.labelsQueried.length ? file.labelsQueried : null }];
    if (file.labelsQueried.length) pulls.push({ labels: null });
    for (const p of pulls) {
      state.calls.push({ at: nowMs });
      const res = await gql(ISSUES_QUERY, { owner, name, first: 50, after: null, labels: p.labels });
      for (const n of res.repository.issues.nodes) if (!byNumber.has(n.number)) byNumber.set(n.number, mapIssue(n));
    }
  } catch {
    return fallback(`Refresh failed or was rate limited; serving the issues as of ${file.fetchedAt}.`);
  }
  const issues = [...byNumber.values()];
  const fetchedAt = new Date(nowMs).toISOString();
  state.cache.set(repo, { at: nowMs, issues, fetchedAt });
  return { issues, fetchedAt, source: 'live-refresh' };
}
