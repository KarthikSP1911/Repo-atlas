import { describe, expect, it } from 'vitest';
import {
  ApiBudget,
  BULK_FILES,
  extractRefs,
  fetchGithubData,
  isBot,
  mapIssue,
  mapPr,
  parseLog,
  personSlug,
  sanitizeError,
  type GraphqlFn,
} from '../src/services/link.service.js';

const SHA = (n: number): string => n.toString(16).padStart(40, '0');

describe('extractRefs', () => {
  it.each([
    ['feat: add totals (#12)', 'a/b', { prRef: 12, fixes: [] }],
    ['Merge pull request #34 from x/y', 'a/b', { prRef: 34, fixes: [] }],
    ['fix(users): dupes, fixes #8 (#15)', 'a/b', { prRef: 15, fixes: [8] }],
    ['chore: x\n\nCloses #5, resolves #7 and Fixed: #9', 'a/b', { prRef: undefined, fixes: [5, 7, 9] }],
    ['fix: y\n\nFixes other/repo#3 and fixes a/b#4', 'a/b', { prRef: undefined, fixes: [4] }],
    ['talks about #99 without a keyword', 'a/b', { prRef: undefined, fixes: [] }],
    ['prefix suffix: fixture #3', 'a/b', { prRef: undefined, fixes: [] }],
  ])('%j', (msg, repo, expected) => {
    expect(extractRefs(msg, repo)).toEqual(expected);
  });
});

describe('parseLog', () => {
  const rec = (n: number, author: string, subj: string, body: string, files: string[]): string =>
    `\x1e${SHA(n)}\x1f${author}\x1f2026-10-0${n}T10:00:00+00:00\x1f${subj}\x1f${body}\x1d\n\n${files.join('\n')}\n`;

  it('parses commits, files, refs and the bulk flag', () => {
    const many = Array.from({ length: BULK_FILES + 1 }, (_, i) => `f${i}.ts`);
    const raw =
      rec(1, 'Alice A', 'feat: totals (#12)', '', ['src/a.ts', 'src/b ü.ts']) +
      rec(2, 'Bob', 'chore: fmt', 'Fixes #8\nmore', many) +
      rec(3, 'Carol', 'Merge branch x', '', []);
    const c = parseLog(raw, 'a/b');
    expect(c.map((x) => x.sha)).toEqual([SHA(1), SHA(2), SHA(3)]);
    expect(c[0]).toMatchObject({ author: 'Alice A', subject: 'feat: totals (#12)', prRef: 12, bulk: false });
    expect(c[0].files).toEqual(['src/a.ts', 'src/b ü.ts']);
    expect(c[1]).toMatchObject({ fixes: [8], bulk: true });
    expect(c[2].files).toEqual([]);
  });

  it('ignores junk records', () => {
    expect(parseLog('garbage\x1e\x1ehello', 'a/b')).toEqual([]);
  });
});

describe('small helpers', () => {
  it.each([
    ['dependabot[bot]', true],
    ['renovate-bot', true],
    ['Renovate Bot', true],
    ['alice', false],
    ['github-actions[bot]', true],
  ])('isBot(%s)', (n, b) => {
    expect(isBot(n)).toBe(b);
  });

  it('personSlug', () => {
    expect(personSlug('Alice B. Smith')).toBe('alice-b-smith');
    expect(personSlug('!!!')).toBe('unknown');
    expect(personSlug('x'.repeat(100)).length).toBe(40);
  });

  it('sanitizeError strips known secrets and token-looking strings', () => {
    const msg = sanitizeError(new Error('bad creds ghp_SECRETSECRETSECRET1234 and Token abcdefghijklmnopqrstuvwxyz0123'), ['ghp_SECRETSECRETSECRET1234']);
    expect(msg).not.toContain('SECRETSECRET');
    expect(msg).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
  });
});

describe('GraphQL mapping', () => {
  it('maps a merged PR and drops the author from reviewers', () => {
    const pr = mapPr({
      number: 21,
      title: 'Retry',
      mergedAt: '2026-10-01T00:00:00Z',
      author: { login: 'carol' },
      reviews: { nodes: [{ author: { login: 'alice' } }, { author: { login: 'alice' } }, { author: { login: 'carol' } }, { author: null }] },
      closingIssuesReferences: { nodes: [{ number: 14, title: 'DB drops', state: 'CLOSED' }] },
      files: { nodes: [{ path: 'src/db/client.ts' }] },
    });
    expect(pr).toEqual({
      number: 21,
      title: 'Retry',
      author: 'carol',
      mergedAt: '2026-10-01T00:00:00Z',
      reviewers: ['alice'],
      closing: [{ number: 14, title: 'DB drops', state: 'CLOSED' }],
      files: ['src/db/client.ts'],
    });
  });

  it('maps an open issue with claim evidence and caps the body', () => {
    const issue = mapIssue({
      number: 40,
      title: 'Crash',
      url: 'https://x/40',
      body: 'b'.repeat(5000),
      createdAt: 'c',
      updatedAt: 'u',
      author: { login: 'zed' },
      authorAssociation: 'NONE',
      labels: { nodes: [{ name: 'good first issue' }] },
      assignees: { nodes: [{ login: 'amy' }] },
      comments: {
        totalCount: 7,
        nodes: [
          { author: { login: 'bob' }, authorAssociation: 'NONE', createdAt: 't', body: 'can I take this?' },
          { author: null, authorAssociation: 'NONE', createdAt: 't2', body: 'x' },
        ],
      },
      timelineItems: {
        nodes: [
          { __typename: 'CrossReferencedEvent', willCloseTarget: true, source: { __typename: 'PullRequest', number: 50, state: 'OPEN', isDraft: false } },
          { __typename: 'CrossReferencedEvent', willCloseTarget: false, source: { __typename: 'Issue' } },
          { __typename: 'ConnectedEvent', subject: { __typename: 'PullRequest', number: 50, state: 'OPEN', isDraft: false } },
        ],
      },
    });
    expect(issue.body).toHaveLength(2000);
    expect(issue.assignees).toEqual(['amy']);
    expect(issue.commentCount).toBe(7);
    expect(issue.comments[1].author).toBeNull();
    expect(issue.linkedPrs).toEqual([{ number: 50, state: 'OPEN', isDraft: false, willClose: true }]);
  });
});

describe('fetchGithubData and ApiBudget', () => {
  const issueNode = (n: number) => ({
    number: n, title: `i${n}`, url: '', body: '', createdAt: 'c', updatedAt: 'u',
    labels: { nodes: [] }, assignees: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, timelineItems: { nodes: [] },
  });
  const prNode = (n: number) => ({
    number: n, title: `p${n}`, mergedAt: 'm', author: { login: 'a' }, reviews: { nodes: [] },
    closingIssuesReferences: { nodes: [] }, files: { nodes: [] },
  });

  function fake(opts: { remainingAfter?: (call: number) => number } = {}) {
    const seen: string[] = [];
    const fn: GraphqlFn = async (query, vars) => {
      const call = seen.length + 1;
      const rateLimit = { cost: 1, remaining: opts.remainingAfter ? opts.remainingAfter(call) : 4000 - call, resetAt: 'r' };
      if (query.includes('pullRequests')) {
        seen.push(`prs after=${String(vars.after)}`);
        return {
          rateLimit,
          repository: {
            description: 'd',
            primaryLanguage: { name: 'TypeScript' },
            defaultBranchRef: { name: 'main' },
            licenseInfo: { spdxId: 'MIT' },
            pullRequests: { pageInfo: { hasNextPage: vars.after === null, endCursor: 'c1' }, nodes: [prNode(vars.after === null ? 1 : 2)] },
          },
        };
      }
      if (query.includes('gfi:')) {
        seen.push('labels');
        return { rateLimit, repository: { gfi: { nodes: [{ name: 'good first issue' }] }, hw: { nodes: [{ name: 'help wanted' }] }, ft: { nodes: [] } } };
      }
      seen.push(`issues labels=${JSON.stringify(vars.labels)}`);
      const labelled = vars.labels !== null;
      return {
        rateLimit,
        repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: labelled ? [issueNode(1), issueNode(2)] : [issueNode(2), issueNode(3)] } },
      };
    };
    return { fn, seen };
  }

  it('makes 5 calls, dedupes issues and records usage', async () => {
    const { fn, seen } = fake();
    const budget = new ApiBudget();
    const d = await fetchGithubData(fn, 'a/b', budget);
    expect(budget.calls).toBe(5);
    expect(seen).toEqual(['prs after=null', 'prs after=c1', 'labels', 'issues labels=["good first issue","help wanted"]', 'issues labels=null']);
    expect(d.prs.map((p) => p.number)).toEqual([1, 2]);
    expect(d.issues.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(d).toMatchObject({ description: 'd', primaryLanguage: 'TypeScript', defaultBranch: 'main', license: 'MIT' });
    expect(budget.cost).toBe(5);
    expect(budget.log).toHaveLength(5);
  });

  it('stops at the call budget and says so', async () => {
    const { fn } = fake();
    const budget = new ApiBudget(2);
    const d = await fetchGithubData(fn, 'a/b', budget);
    expect(budget.calls).toBe(2);
    expect(budget.stoppedReason).toMatch(/call budget of 2/);
    expect(d.limits.join(' ')).toMatch(/Stopped early/);
    expect(d.issues).toEqual([]);
  });

  it('stops when GitHub reports few points remaining', async () => {
    const { fn } = fake({ remainingAfter: () => 50 });
    const budget = new ApiBudget(30, 100);
    const d = await fetchGithubData(fn, 'a/b', budget);
    expect(budget.calls).toBe(1);
    expect(budget.stoppedReason).toMatch(/only 50 GraphQL points remain/);
    expect(d.prs).toHaveLength(1);
  });

  it('does not swallow real errors', async () => {
    const boom: GraphqlFn = async () => {
      throw new Error('network down');
    };
    await expect(fetchGithubData(boom, 'a/b', new ApiBudget())).rejects.toThrow('network down');
  });
});
