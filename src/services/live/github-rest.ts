import type { OpenIssue } from '../issues.schema.js';
import { cleanAuthorName, scrubEmails } from '../privacy.js';
import { BULK_FILES, extractRefs, type HistoryCommit } from '../people.js';
import type { RepoSpec } from './repo-spec.js';

/**
 * The few GitHub REST calls the live build makes for what a tarball cannot give: description and
 * default branch, recent commits, open issues. Works without a token (60 calls an hour per
 * server address) and much better with one. The token is only ever sent to api.github.com, in
 * an Authorization header, and never appears in a returned value or a message.
 */

const API = 'https://api.github.com';

export interface RestOptions {
  token?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export type RestResult<T> = { ok: true; data: T } | { ok: false; status: number; note: string };

async function get<T>(path: string, o: RestOptions): Promise<RestResult<T>> {
  const f = o.fetchFn ?? fetch;
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'repoatlas', 'x-github-api-version': '2022-11-28' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  try {
    const res = await f(`${API}${path}`, { headers, signal: AbortSignal.timeout(o.timeoutMs ?? 12_000) });
    if (res.status === 403 || res.status === 429) {
      const left = res.headers.get('x-ratelimit-remaining');
      return { ok: false, status: res.status, note: left === '0' || res.status === 429 ? 'GitHub API rate limit reached' : 'GitHub API refused the request' };
    }
    if (res.status === 404) return { ok: false, status: 404, note: 'not found' };
    if (!res.ok) return { ok: false, status: res.status, note: `GitHub API answered HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: 0, note: 'could not reach the GitHub API' };
  }
}

export interface RepoMeta {
  fullName: string;
  description: string | null;
  primaryLanguage: string | null;
  defaultBranch: string | null;
  license: string | null;
  archived: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function fetchRepoMeta(spec: RepoSpec, o: RestOptions): Promise<RestResult<RepoMeta>> {
  const r = await get<any>(`/repos/${spec.owner}/${spec.name}`, o);
  if (!r.ok) return r;
  const d = r.data;
  return {
    ok: true,
    data: {
      fullName: typeof d.full_name === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(d.full_name) ? d.full_name : spec.repo,
      description: typeof d.description === 'string' ? scrubEmails(d.description).slice(0, 300) : null,
      primaryLanguage: typeof d.language === 'string' ? d.language : null,
      defaultBranch: typeof d.default_branch === 'string' ? d.default_branch : null,
      license: typeof d.license?.spdx_id === 'string' && d.license.spdx_id !== 'NOASSERTION' ? d.license.spdx_id : null,
      archived: Boolean(d.archived),
    },
  };
}

export interface CommitsResult {
  commits: HistoryCommit[];
  notes: string[];
}

/** Latest commits (one call). With a token, also the changed files of the newest ones (one call each). */
export async function fetchCommits(spec: RepoSpec, o: RestOptions & { limit?: number; detailLimit?: number; deadlineAt?: number }): Promise<CommitsResult> {
  const limit = Math.min(o.limit ?? 100, 100);
  const notes: string[] = [];
  const list = await get<any[]>(`/repos/${spec.owner}/${spec.name}/commits?per_page=${limit}`, o);
  if (!list.ok) return { commits: [], notes: [`Commit history unavailable (${list.note}), so churn, owners and history-based file matching are empty.`] };

  const commits: HistoryCommit[] = [];
  for (const c of list.data) {
    const sha = typeof c?.sha === 'string' ? c.sha : '';
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    const message = String(c.commit?.message ?? '');
    const refs = extractRefs(message, spec.repo);
    commits.push({
      sha,
      subject: scrubEmails(message.split('\n', 1)[0]).slice(0, 160),
      date: String(c.commit?.author?.date ?? c.commit?.committer?.date ?? new Date(0).toISOString()),
      author: cleanAuthorName(String(c.commit?.author?.name ?? c.author?.login ?? 'unknown')),
      files: [],
      prRef: refs.prRef,
      fixes: refs.fixes,
      bulk: false,
    });
  }

  if (!o.token) {
    notes.push('Which files each commit changed was not read (no GitHub token on the server), so churn, owners and co-change are empty; commit messages and authors are still included.');
    return { commits, notes };
  }

  const want = Math.min(o.detailLimit ?? 40, commits.length);
  let next = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    while (next < want) {
      const c = commits[next++];
      if (o.deadlineAt && Date.now() > o.deadlineAt) {
        failed++;
        continue;
      }
      const d = await get<any>(`/repos/${spec.owner}/${spec.name}/commits/${c.sha}`, o);
      if (!d.ok) {
        failed++;
        continue;
      }
      const files = (Array.isArray(d.data.files) ? d.data.files : []).map((f: any) => f?.filename).filter((x: unknown): x is string => typeof x === 'string');
      c.files = files;
      c.bulk = files.length > BULK_FILES;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  notes.push(`Changed files were read for the newest ${want - failed} of ${commits.length} commits; older commits count for messages and authors only.`);
  return { commits, notes };
}

export interface IssuesResult {
  issues: OpenIssue[];
  notes: string[];
}

function mapRestIssue(n: any, spec: RepoSpec): OpenIssue | null {
  if (!n || n.pull_request || !Number.isInteger(n.number)) return null;
  return {
    number: n.number,
    title: scrubEmails(String(n.title ?? '')).slice(0, 400),
    url: typeof n.html_url === 'string' && n.html_url.startsWith('https://github.com/') ? n.html_url : `https://github.com/${spec.repo}/issues/${n.number}`,
    body: scrubEmails(String(n.body ?? '')).slice(0, 2000),
    labels: (Array.isArray(n.labels) ? n.labels : []).map((l: any) => (typeof l === 'string' ? l : String(l?.name ?? ''))).filter(Boolean),
    assignees: (Array.isArray(n.assignees) ? n.assignees : []).map((a: any) => String(a?.login ?? '')).filter(Boolean),
    author: typeof n.user?.login === 'string' ? n.user.login : null,
    authorAssociation: String(n.author_association ?? 'NONE'),
    createdAt: String(n.created_at ?? new Date(0).toISOString()),
    updatedAt: String(n.updated_at ?? n.created_at ?? new Date(0).toISOString()),
    commentCount: Number.isInteger(n.comments) && n.comments >= 0 ? n.comments : 0,
    comments: [],
    linkedPrs: [],
  };
}

const ISSUE_NOTE = 'Issue comments and linked pull requests were not read, so "likely unclaimed" rests on assignees and labels only. A token on the server enables the fuller check.';

/**
 * Open issues, newest activity first. The search endpoint returns issues only and has its own,
 * separate rate limit, so it is tried first; the plain list mixes in pull requests (in a busy repo
 * most of a page), so the fallback reads up to three pages and keeps just the issues.
 */
export async function fetchIssuesRest(spec: RepoSpec, o: RestOptions & { limit?: number }): Promise<IssuesResult> {
  const want = Math.min(o.limit ?? 100, 100);
  const q = encodeURIComponent(`repo:${spec.repo} is:issue is:open`);
  const search = await get<{ items?: any[] }>(`/search/issues?q=${q}&sort=updated&order=desc&per_page=${want}`, o);
  if (search.ok && Array.isArray(search.data.items)) {
    const issues = search.data.items.map((n) => mapRestIssue(n, spec)).filter((x): x is OpenIssue => x !== null);
    return { issues, notes: [ISSUE_NOTE] };
  }

  const issues: OpenIssue[] = [];
  let lastFailure = search.ok ? 'unexpected answer' : search.note;
  let listOk = false;
  for (let page = 1; page <= 3 && issues.length < 50; page++) {
    const r = await get<any[]>(`/repos/${spec.owner}/${spec.name}/issues?state=open&sort=updated&direction=desc&per_page=100&page=${page}`, o);
    if (!r.ok) {
      lastFailure = r.note;
      break;
    }
    listOk = true;
    for (const n of r.data) {
      const m = mapRestIssue(n, spec);
      if (m) issues.push(m);
    }
    if (r.data.length < 100) break;
  }
  if (!listOk) return { issues, notes: [`Open issues unavailable (${lastFailure}), so find_candidate_issues has nothing to rank.`] };
  return { issues: issues.slice(0, want), notes: [ISSUE_NOTE] };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
