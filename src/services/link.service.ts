import { graphql } from '@octokit/graphql';
import type { OpenIssue } from './issues.schema.js';
import { scrubEmails, cleanAuthorName } from './privacy.js';
import { ISSUES_QUERY, LABELS_QUERY, PR_QUERY, BEGINNER_LABEL, mapIssue, mapPr, type GraphqlFn, type PrData } from './github.graphql.js';

export { scrubEmails, cleanAuthorName, BEGINNER_LABEL, mapIssue, mapPr };
export type { GraphqlFn, PrData };
import { gitClient } from './ingest.service.js';
import { BULK_FILES, extractRefs, isBot, personSlug, type HistoryCommit } from './people.js';

export * from './people.js';
export * from './github.fetch.js';

/**
 * OFFLINE ONLY. History and people from `git log --name-only` (never `--numstat`, which would
 * download blobs), plus one budgeted GraphQL pass for merged PRs and open issues.
 */

// --- History ---------------------------------------------------------------

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

// --- GitHub GraphQL (budgeted) ----------------------------------------------

export function makeGraphql(token: string): GraphqlFn {
  const client = graphql.defaults({ headers: { authorization: `token ${token}`, 'user-agent': 'repoatlas-precompute' } });
  return (query, variables) => client(query, variables);
}

