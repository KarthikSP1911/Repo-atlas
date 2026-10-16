import { CANDIDATES } from '../config/weights.js';
import type { OpenIssue } from './issues.schema.js';

/**
 * Pure helpers over the open-issues file. All issue text (title, body, comments) is UNTRUSTED
 * data written by strangers: these functions only measure it, they never act on what it says.
 */

export const MS_PER_DAY = 86_400_000;

export function daysBetween(fromIso: string, toIso: string): number {
  const d = (Date.parse(toIso) - Date.parse(fromIso)) / MS_PER_DAY;
  return Number.isFinite(d) ? Math.max(0, d) : 0;
}

export interface Clarity {
  /** 0..1. */
  score: number;
  signals: string[];
  /** True when the issue is long and specific enough to start from. */
  clearEnough: boolean;
}

const REPRO = /(steps? to reproduce|to reproduce|how to reproduce|repro(duction)?\b|minimal (example|reproduction)|\n\s*1[.)]\s)/i;
const ERROR_TEXT = /(error:|exception|traceback|stack ?trace|\bTypeError\b|\bReferenceError\b|\bpanic:|segmentation fault|cannot read|is not defined|undefined is not|failed with|exit code \d+)/i;
const EXPECTED = /(expected|should (be|return|show|not)|acceptance|would like|it would be (nice|great)|proposal|suggest)/i;

export function clarityOf(issue: Pick<OpenIssue, 'title' | 'body'>): Clarity {
  const body = issue.body ?? '';
  const signals: string[] = [];
  let score = 0;
  if (body.trim().length >= CANDIDATES.minBodyChars) {
    score += 0.3;
    signals.push(`description of ${body.trim().length} characters`);
  }
  if (body.trim().length >= 200) {
    score += 0.15;
    signals.push('detailed description');
  }
  if (REPRO.test(body)) {
    score += 0.2;
    signals.push('reproduction steps');
  }
  if (ERROR_TEXT.test(body) || /```/.test(body)) {
    score += 0.15;
    signals.push(ERROR_TEXT.test(body) ? 'error text' : 'code sample');
  }
  if (EXPECTED.test(body)) {
    score += 0.2;
    signals.push('expected behaviour or acceptance hint');
  }
  if (issue.title.trim().length < 8) score -= 0.1;
  const clamped = Math.max(0, Math.min(1, score));
  return { score: Number(clamped.toFixed(2)), signals, clearEnough: body.trim().length >= CANDIDATES.minBodyChars && clamped >= 0.3 };
}

export interface ClaimEvidence {
  /** True when something says someone else is already on it. */
  claimed: boolean;
  /** True when a merged PR already links to the issue (it may be fixed). */
  maybeFixed: boolean;
  /** Plain-language evidence, one line per signal, for the "likely unclaimed" label. */
  evidence: string[];
}

const CLAIM_PHRASE = /\b(can i (take|work|try|pick|do|have)|could i (take|work|try|pick|do)|may i (take|work|try)|i('| wi)ll (take|work|try|pick|do|submit|send|open|fix|give)|i can (take|work|do|fix|submit)|i('| a)m (working|going to work|on it)|working on (this|it)|let me (take|work|try|do|fix)|i('| woul)d (like|love) to (work|take|try|fix|help|submit)|taking this|take this|assign (this )?(issue )?to me|assign me|claim(ing)? this|on it\b)/i;

/** `now` is when the issues file was fetched, so results do not drift with the reader's clock. */
export function claimEvidence(issue: OpenIssue, now: string): ClaimEvidence {
  const evidence: string[] = [];
  let claimed = false;
  let maybeFixed = false;
  if (issue.assignees.length) {
    claimed = true;
    evidence.push(`assigned to ${issue.assignees.slice(0, 3).join(', ')}`);
  }
  for (const pr of issue.linkedPrs) {
    if (pr.state === 'MERGED') {
      maybeFixed = true;
      evidence.push(`merged PR #${pr.number} is linked (it may already be fixed)`);
    } else if (pr.state === 'OPEN') {
      claimed = true;
      evidence.push(`open PR #${pr.number}${pr.isDraft ? ' (draft)' : ''} is linked`);
    }
  }
  const recent = issue.comments.filter((c) => daysBetween(c.createdAt, now) <= CANDIDATES.claimCommentDays && CLAIM_PHRASE.test(c.body));
  if (recent.length) {
    claimed = true;
    const c = recent[recent.length - 1];
    evidence.push(`recent comment by ${c.author ?? 'someone'} reads like a claim (${Math.round(daysBetween(c.createdAt, now))} days ago)`);
  }
  if (!claimed && !maybeFixed) {
    evidence.push('no assignee, no linked open PR, no recent "can I take this" style comment in the last 5 comments');
  }
  return { claimed, maybeFixed, evidence };
}

export function hasLabel(issue: Pick<OpenIssue, 'labels'>, wanted: readonly string[]): string[] {
  const want = new Set(wanted.map((w) => w.toLowerCase()));
  return issue.labels.filter((l) => want.has(l.toLowerCase()));
}
