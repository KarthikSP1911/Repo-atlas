/** History and people helpers shared by the offline engine and the live build. Pure; no heavy imports. */

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

export function isBot(name: string): boolean {
  return /\[bot\]$|^dependabot|^renovate|^github-actions|^greenkeeper|^pre-commit-ci/i.test(name);
}

export function personSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unknown';
}

