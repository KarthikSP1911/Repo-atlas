import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSnapshot } from '../src/services/build.service.js';
import { IssuesFileSchema } from '../src/services/issues.schema.js';
import { SnapshotSchema, snapshotId } from '../src/services/snapshot.schema.js';
import type { GraphqlFn } from '../src/services/link.service.js';

/**
 * End to end on a real local git repo: clone by file:// URL, parse, history, analysis and
 * assembly, with a scripted GraphQL client. No network and no token.
 */

let tmp: string;
let repoDir: string;
let head: string;
let cloneUrl: string;
let n = 0;
const workDir = (): string => path.join(tmp, `work-${n++}`);

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}
function write(rel: string, text: string): void {
  const p = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
function commit(msg: string, who: { name: string; email: string }, date: string): void {
  git(['add', '-A', '-f'], {});
  git(['commit', '-q', '-m', msg], {
    GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_COMMITTER_DATE: date,
  });
}

const alice = { name: 'Alice', email: 'alice@example.com' };
const bob = { name: 'Bob', email: 'bob@example.com' };
const bot = { name: 'dependabot[bot]', email: 'bot@example.com' };

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repoatlas-build-'));
  repoDir = path.join(tmp, 'fixture');
  fs.mkdirSync(repoDir);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'uploadpack.allowFilter', 'true']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'core.safecrlf', 'false']);

  write('package.json', JSON.stringify({ name: 'fixture', description: 'A fixture', main: 'dist/index.js', scripts: { start: 'node dist/server.js', test: 'vitest' }, dependencies: { express: '^4' } }));
  write('tsconfig.json', '{"compilerOptions":{}}');
  write('README.md', '# Fixture\n\nA fixture project that exercises the engine end to end.\n\nStart in `src/server.ts`. The code in src/db/ stores data.\n');
  write('src/index.ts', "export * from './server.js';\n");
  write('src/server.ts', "import { users } from './users/service.js';\nimport { log } from './util.js';\nlog(users());\napp.listen(3000);\n");
  write('src/users/service.ts', "import { query } from '../db/client.js';\nexport const users = () => query('select');\n");
  write('src/util.ts', 'export const log = (x: unknown) => console.log(x);\n');
  write('src/db/client.ts', 'export const query = (q: string) => q;\n');
  write('tests/users/service.test.ts', "import { users } from '../../src/users/service.js';\nusers();\n");
  write('package-lock.json', '{}');
  write('node_modules/junk/x.js', 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repoDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  commit('chore: initial import', alice, '2026-09-01T10:00:00Z');

  write('src/users/service.ts', "import { query } from '../db/client.js';\nexport const users = () => query('select users');\n");
  commit('feat: list users (#1)', alice, '2026-09-02T10:00:00Z');

  write('src/users/service.ts', "import { query } from '../db/client.js';\nexport const users = () => query('select distinct users');\n");
  write('tests/users/service.test.ts', "import { users } from '../../src/users/service.js';\nusers();\nusers();\n");
  commit('fix: dedupe users (#3)\n\nFixes #2', bob, '2026-09-03T10:00:00Z');

  write('package.json', JSON.stringify({ name: 'fixture', description: 'A fixture', main: 'dist/index.js', scripts: { start: 'node dist/server.js', test: 'vitest' }, dependencies: { express: '^4.1' } }));
  commit('chore(deps): bump express', bot, '2026-09-04T10:00:00Z');

  head = git(['rev-parse', 'HEAD']);
  cloneUrl = pathToFileURL(repoDir).href;
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const prNode = {
  number: 3, title: 'Dedupe users', mergedAt: '2026-09-03T10:30:00Z', author: { login: 'bob' },
  reviews: { nodes: [{ author: { login: 'alice' } }] },
  closingIssuesReferences: { nodes: [{ number: 2, title: 'Duplicate users listed', state: 'CLOSED' }] },
  files: { nodes: [{ path: 'src/users/service.ts' }, { path: 'not/in/repo.ts' }] },
};
const openIssue = {
  number: 9, title: 'Add pagination', url: 'https://example.test/9', body: 'Please add pagination to users.', createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z',
  author: { login: 'zed' }, authorAssociation: 'NONE', labels: { nodes: [{ name: 'good first issue' }] }, assignees: { nodes: [] },
  comments: { totalCount: 0, nodes: [] }, timelineItems: { nodes: [] },
};
const fakeGql: GraphqlFn = async (query, vars) => {
  const rateLimit = { cost: 1, remaining: 4900, resetAt: 'r' };
  if (query.includes('pullRequests')) {
    return { rateLimit, repository: { description: 'GitHub description', primaryLanguage: { name: 'TypeScript' }, defaultBranchRef: { name: 'main' }, licenseInfo: { spdxId: 'MIT' }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [prNode] } } };
  }
  if (query.includes('gfi:')) return { rateLimit, repository: { gfi: { nodes: [{ name: 'good first issue' }] }, hw: { nodes: [] }, ft: { nodes: [] } } };
  return { rateLimit, repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: vars.labels ? [openIssue] : [] } } };
};

describe('buildSnapshot on a real git repo', () => {
  it('builds a valid, complete snapshot', async () => {
    const r = await buildSnapshot({ repo: 'demo/fixture', workDir: workDir(), cloneUrl, graphql: fakeGql, now: () => new Date('2026-10-16T12:00:00Z') });
    const s = r.snapshot;
    expect(SnapshotSchema.safeParse(s).success).toBe(true);
    expect(s).toMatchObject({ repo: 'demo/fixture', sha: head, tier: 2, truncated: false, builtAt: '2026-10-16T12:00:00.000Z', commitWindow: 4 });
    expect(r.id).toBe(snapshotId('demo/fixture', head));

    const ids = new Set(s.nodes.map((x) => x.id));
    for (const bad of ['file:package-lock.json', 'file:logo.png', 'file:node_modules/junk/x.js']) expect(ids.has(bad)).toBe(false);
    for (const good of ['dir:.', 'dir:src', 'dir:src/db', 'file:src/server.ts', 'file:README.md', 'entry:src/server.ts', 'entry:src/index.ts', 'doc:README.md', 'person:alice', 'person:bob', 'pr:3', 'issue:2']) expect(ids.has(good), good).toBe(true);
    expect([...ids].some((i) => i.includes('dependabot'))).toBe(false);

    const has = (from: string, to: string, kind: string, confidence?: string): boolean =>
      s.edges.some((e) => e.from === from && e.to === to && e.kind === kind && (confidence === undefined || e.confidence === confidence));
    expect(has('file:src/server.ts', 'file:src/users/service.ts', 'imports')).toBe(true);
    expect(has('file:src/users/service.ts', 'file:src/db/client.ts', 'imports')).toBe(true);
    expect(has('file:src/index.ts', 'file:src/server.ts', 'imports')).toBe(true);
    expect(has('entry:src/server.ts', 'file:src/server.ts', 'starts')).toBe(true);
    expect(has('dir:src', 'dir:src/db', 'contains')).toBe(true);
    expect(has('doc:README.md', 'file:src/server.ts', 'describes', 'exact')).toBe(true);
    expect(has('doc:README.md', 'dir:src/db', 'describes', 'exact')).toBe(true);
    expect(has('pr:3', 'file:src/users/service.ts', 'touches')).toBe(true);
    expect(has('person:bob', 'pr:3', 'authored')).toBe(true);
    expect(has('person:alice', 'pr:3', 'reviewed')).toBe(true);
    expect(has('pr:3', 'issue:2', 'fixes', 'exact')).toBe(true);

    const commits = s.nodes.filter((x) => x.kind === 'commit');
    const bobCommit = commits.find((c) => c.label.startsWith('fix: dedupe'))!;
    expect(has(bobCommit.id, 'issue:2', 'fixes', 'exact')).toBe(true); // message said "Fixes #2 (#3)" and PR 3 closes #2
    expect(has(bobCommit.id, 'file:src/users/service.ts', 'touches')).toBe(true);
    expect(has('person:bob', bobCommit.id, 'authored')).toBe(true);
    expect(commits.find((c) => c.label.startsWith('feat: list users'))!.meta.prNumber).toBe(1);

    const svc = s.nodes.find((x) => x.id === 'file:src/users/service.ts')!.meta;
    expect(svc).toMatchObject({ lang: 'ts', churn: 3, fanIn: 1, fanOut: 1, testedBy: ['tests/users/service.test.ts'] });
    expect(svc.docsMentions).toBeUndefined(); // zero values are omitted to save bytes
    expect(svc.owners).toEqual(['person:alice', 'person:bob']);
    expect(s.nodes.find((x) => x.id === 'file:src/server.ts')!.meta).toMatchObject({ isEntry: true });
    expect(s.nodes.find((x) => x.id === 'file:package.json')!.meta).toMatchObject({ isConfig: true });
    expect(s.nodes.find((x) => x.id === 'file:tests/users/service.test.ts')!.meta).toMatchObject({ isTest: true, testFor: ['src/users/service.ts'] });

    const root = s.nodes.find((x) => x.id === 'dir:.')!.meta.project as Record<string, unknown>;
    expect(root).toMatchObject({ name: 'fixture', description: 'A fixture', license: 'MIT', primaryLanguage: 'TypeScript', defaultBranch: 'main' });
    expect(root.stack).toContain('Express');
  });

  it('stores no email addresses and no token anywhere', async () => {
    const r = await buildSnapshot({ repo: 'demo/fixture', workDir: workDir(), cloneUrl, graphql: fakeGql });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/@example\.com/);
    expect(text).not.toMatch(/ghp_|github_pat_/);
  });

  it('writes a valid issues file and records API usage', async () => {
    const r = await buildSnapshot({ repo: 'demo/fixture', workDir: workDir(), cloneUrl, graphql: fakeGql });
    const parsed = IssuesFileSchema.safeParse(r.issues);
    expect(parsed.success).toBe(true);
    expect(r.issues).toMatchObject({ snapshotId: r.id, labelsQueried: ['good first issue'] });
    expect(r.issues.issues.map((i) => i.number)).toEqual([9]);
    expect(r.report.api).toMatchObject({ calls: 4, maxCalls: 30, cost: 4, remaining: 4900 });
    expect(r.report).toMatchObject({ prs: 1, openIssues: 1, commitsRead: 4 });
  });

  it('builds without GitHub data and says so', async () => {
    const r = await buildSnapshot({ repo: 'demo/fixture', workDir: workDir(), cloneUrl, graphql: null });
    expect(r.snapshot.nodes.some((x) => x.kind === 'pr')).toBe(false);
    expect(r.report.warnings.join(' ')).toMatch(/No GitHub token/);
    expect(r.issues.issues).toEqual([]);
    expect(r.report.api.calls).toBe(0);
  });

  it('applies the file cap and marks the snapshot truncated', async () => {
    const r = await buildSnapshot({ repo: 'demo/fixture', workDir: workDir(), cloneUrl, graphql: null, maxFiles: 3 });
    expect(r.snapshot.truncated).toBe(true);
    expect(r.snapshot.nodes.filter((x) => x.kind === 'file')).toHaveLength(3);
    expect(r.report.warnings.join(' ')).toMatch(/File cap/);
    expect(SnapshotSchema.safeParse(r.snapshot).success).toBe(true);
  });

  it('trims history to fit the size budget, and fails clearly when nothing fits', async () => {
    const full = await buildSnapshot({ repo: 'demo/fixture', workDir: workDir(), cloneUrl, graphql: null });
    const fullCommits = full.snapshot.nodes.filter((x) => x.kind === 'commit').length;
    expect(fullCommits).toBeGreaterThan(0);

    const noCommits = await buildSnapshot({ repo: 'demo/fixture', workDir: workDir(), cloneUrl, graphql: null, maxBytes: full.report.bytes - 1 });
    expect(noCommits.snapshot.truncated).toBe(true);
    expect(noCommits.report.warnings.join(' ')).toMatch(/Size budget/);
    expect(noCommits.report.bytes).toBeLessThan(full.report.bytes);

    await expect(buildSnapshot({ repo: 'demo/fixture', workDir: workDir(), cloneUrl, graphql: null, maxBytes: 100 })).rejects.toThrow(/even after trimming/);
  });
});
