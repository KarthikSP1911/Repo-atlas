import { describe, expect, it } from 'vitest';
import { buildLiveSnapshot } from '../src/services/live/build-live.js';
import { LiveBuildError } from '../src/services/live/fetch-tarball.js';
import { parseRepoSpec } from '../src/services/live/repo-spec.js';
import { SnapshotSchema, getFileMeta, type Snapshot } from '../src/services/snapshot.schema.js';
import { IssuesFileSchema } from '../src/services/issues.schema.js';
import { indexFor } from '../src/services/graph.query.js';
import { COMMIT_1, FIXTURE_SHA, fixtureFetch, fixtureFiles, type Req } from './helpers/live-fixture.js';

const spec = parseRepoSpec('https://github.com/acme/widgets')!;
const NOW = new Date('2026-10-17T12:00:00Z');
const build = (o: Parameters<typeof fixtureFetch>[0] = {}, extra: Parameters<typeof buildLiveSnapshot>[1] = {}) =>
  buildLiveSnapshot(spec, { fetchFn: fixtureFetch(o), now: () => NOW, ...extra });

const filePaths = (s: Snapshot): string[] => s.nodes.filter((n) => n.kind === 'file').map((n) => String(n.meta.path)).sort();
const importEdges = (s: Snapshot): string[] => s.edges.filter((e) => e.kind === 'imports').map((e) => `${e.from.slice(5)} -> ${e.to.slice(5)}`).sort();

describe('buildLiveSnapshot without a token', () => {
  it('turns a GitHub archive into a valid tier-2 snapshot', async () => {
    const r = await build();
    expect(SnapshotSchema.safeParse(r.snapshot).success).toBe(true);
    expect(r.id).toBe('acme__widgets@bbbbbbb');
    expect(r.snapshot).toMatchObject({ repo: 'acme/widgets', sha: FIXTURE_SHA, tier: 2, truncated: false, builtAt: NOW.toISOString() });
    expect(r.snapshot.source?.kind).toBe('live');
  });

  it('keeps source files, drops binaries, lockfiles and vendored folders', async () => {
    const { snapshot } = await build();
    expect(filePaths(snapshot)).toEqual(['LICENSE', 'README.md', 'docs/architecture.md', 'package.json', 'src/db.ts', 'src/index.ts', 'src/lib/helper.ts', 'src/routes/user.ts', 'src/server.ts', 'src/types.ts', 'tests/server.test.ts', 'tsconfig.json']);
  });

  it('finds imports: relative, path aliases from a commented tsconfig, type imports, and ignores commented-out ones', async () => {
    const { snapshot } = await build();
    expect(importEdges(snapshot)).toEqual([
      'src/db.ts -> src/types.ts',
      'src/index.ts -> src/lib/helper.ts', // "@lib/helper" through tsconfig paths
      'src/index.ts -> src/server.ts', // "./server.js" resolves to server.ts
      'src/routes/user.ts -> src/db.ts',
      'src/routes/user.ts -> src/types.ts',
      'src/server.ts -> src/routes/user.ts',
      'tests/server.test.ts -> src/server.ts',
    ]);
  });

  it('recognises the entry point, the test file and the docs link', async () => {
    const { snapshot } = await build();
    const idx = indexFor(snapshot);
    expect(snapshot.nodes.filter((n) => n.kind === 'entry').map((n) => n.meta.path)).toContain('src/index.ts');
    expect(getFileMeta(snapshot.nodes.find((n) => n.id === 'file:src/index.ts')!)).toMatchObject({ isEntry: true, lang: 'ts', doc: 'Entry point: starts the HTTP server.' });
    expect(getFileMeta(snapshot.nodes.find((n) => n.id === 'file:tests/server.test.ts')!).isTest).toBe(true);
    expect(idx.project.name).toBe('widgets');
    expect(idx.files.get('src/types.ts')!.meta.fanIn).toBe(2);
  });

  it('reads description, license and commits over REST, and keeps emails out', async () => {
    const { snapshot, report } = await build();
    const root = snapshot.nodes.find((n) => n.id === 'dir:.')!;
    expect(root.meta.project).toMatchObject({ description: 'A tiny widget service', license: 'MIT', primaryLanguage: 'TypeScript', defaultBranch: 'main' });
    // Without a token the commits are read but carry no changed-file lists, so none become graph nodes.
    expect(report.commits).toBe(3);
    expect(snapshot.commitWindow).toBe(3);
    expect(snapshot.nodes.filter((n) => n.kind === 'commit')).toHaveLength(0);
    expect(JSON.stringify(snapshot)).not.toMatch(/@example\.com/);
  });

  it('lists open issues without pull requests, as untrusted data, and says what was not read', async () => {
    const { issues, snapshot } = await build();
    expect(IssuesFileSchema.safeParse(issues).success).toBe(true);
    expect(issues.snapshotId).toBe('acme__widgets@bbbbbbb');
    expect(issues.issues.map((i) => i.number)).toEqual([7]);
    expect(issues.issues[0]).toMatchObject({ labels: ['good first issue'], assignees: [], commentCount: 2, comments: [], linkedPrs: [] });
    expect(issues.limits.join(' ')).toMatch(/comments and linked pull requests were not read/);
    expect(snapshot.source!.notes.join(' ')).toMatch(/no GitHub token/);
  });

  it('states in the notes how it was built and that the import graph is approximate', async () => {
    const { snapshot } = await build();
    const notes = snapshot.source!.notes.join('\n');
    expect(notes).toMatch(/Built on demand from GitHub's archive .* commit bbbbbbb/);
    expect(notes).toMatch(/text scan rather than a compiler/);
    expect(notes).toMatch(/churn, owners and co-change are empty/);
  });

  it('makes no authenticated calls, and fetches the archive only from codeload.github.com', async () => {
    const reqs: Req[] = [];
    await build({ reqs });
    expect(reqs.every((r) => r.auth === null)).toBe(true);
    expect(reqs.filter((r) => r.url.startsWith('https://codeload.github.com/')).map((r) => r.url)).toEqual(['https://codeload.github.com/acme/widgets/tar.gz/HEAD']);
    expect(reqs.every((r) => /^https:\/\/(codeload|api)\.github\.com\//.test(r.url))).toBe(true);
    expect(reqs.some((r) => /\/commits\/[0-9a-f]{40}$/.test(r.url))).toBe(false); // per-commit file lists need a token
  });
});

describe('buildLiveSnapshot with a token', () => {
  const token = 'ghp_FAKE_TOKEN_FOR_TESTS_0123456789abcdef';

  it('adds changed files per commit, merged PRs and issue comments, and sends the token only to api.github.com', async () => {
    const reqs: Req[] = [];
    const r = await build({ reqs, graphql: 'ok' }, { token });
    const authed = reqs.filter((x) => x.auth !== null);
    expect(authed.length).toBeGreaterThan(3);
    expect(authed.every((x) => x.url.startsWith('https://api.github.com/'))).toBe(true);
    expect(reqs.filter((x) => x.url.startsWith('https://codeload.github.com/')).every((x) => x.auth === null)).toBe(true);

    const touches = r.snapshot.edges.filter((e) => e.kind === 'touches' && e.to === 'file:src/db.ts');
    expect(touches.length).toBeGreaterThanOrEqual(2); // two commits and the PR layer
    expect(r.snapshot.nodes.some((n) => n.id === 'pr:12')).toBe(true);
    expect(r.snapshot.edges.some((e) => e.kind === 'fixes' && e.from === 'pr:12' && e.to === 'issue:7' && e.confidence === 'exact')).toBe(true);
    expect(r.report.prs).toBe(1);
    expect(r.issues.issues[0].comments).toHaveLength(1);
    expect(r.issues.labelsQueried).toEqual(['good first issue']);
    const idx = indexFor(r.snapshot);
    expect(idx.files.get('src/db.ts')!.meta.churn).toBeGreaterThan(0);
    expect(r.snapshot.nodes.filter((n) => n.kind === 'commit').length).toBe(3);
    expect(JSON.stringify(r.snapshot)).not.toMatch(/@example\.com/); // an email used as an author name is scrubbed
    expect(r.snapshot.nodes.some((n) => n.kind === 'person' && n.label === 'bob')).toBe(true);
  });

  it('never puts the token in the snapshot, the issues, the report or any note', async () => {
    const r = await build({ graphql: 'ok' }, { token });
    expect(JSON.stringify(r)).not.toContain(token);
    expect(JSON.stringify(r)).not.toContain('FAKE_TOKEN');
  });

  it('falls back to REST, with a sanitised note, when the GraphQL call fails', async () => {
    const r = await build({ graphql: 'fail' }, { token });
    const notes = r.snapshot.source!.notes.join('\n');
    expect(notes).toMatch(/fuller GitHub query failed/);
    expect(JSON.stringify(r)).not.toContain(token);
    expect(r.issues.issues.map((i) => i.number)).toEqual([7]); // REST issues instead
    expect(r.report.prs).toBe(0);
  });

  it('reads changed files for the newest commits through REST when GraphQL is not used', async () => {
    const reqs: Req[] = [];
    await build({ reqs, graphql: 'fail' }, { token });
    expect(reqs.filter((x) => /\/commits\/[0-9a-f]{40}$/.test(x.url)).map((x) => x.url.slice(-40))).toContain(COMMIT_1);
  });
});

describe('buildLiveSnapshot limits and failures', () => {
  it('still builds, with a plain note, when the GitHub API is rate limited', async () => {
    const r = await build({ rest: 'ratelimit' });
    expect(r.snapshot.tier).toBe(2);
    expect(r.snapshot.nodes.filter((n) => n.kind === 'commit')).toHaveLength(0);
    const notes = r.snapshot.source!.notes.join('\n');
    expect(notes).toMatch(/Commit history unavailable \(GitHub API rate limit reached\)/);
    expect(r.issues.issues).toEqual([]);
    expect(r.issues.limits.join(' ')).toMatch(/Open issues unavailable/);
  });

  it('falls back to paging the plain issue list when the search endpoint fails, keeping only real issues', async () => {
    const r = await build({ search: 'fail' });
    expect(r.issues.issues.map((i) => i.number)).toEqual([7]);
  });

  it('prefers the authenticated archive route when a token is given, and falls back to codeload when it is refused', async () => {
    const reqs: Req[] = [];
    await build({ reqs }, { token: 'tkn_abc' });
    expect(reqs.some((r) => r.url === 'https://api.github.com/repos/acme/widgets/tarball' && r.auth === 'Bearer tkn_abc')).toBe(true);
    expect(reqs.filter((r) => r.url.startsWith('https://codeload.github.com/')).every((r) => r.auth === null)).toBe(true); // the token is not forwarded to the redirect target

    const refused: Req[] = [];
    const r = await build({ reqs: refused, apiTarball: 'refuse' }, { token: 'tkn_abc' });
    expect(r.snapshot.tier).toBe(2);
    expect(refused.some((x) => x.url === 'https://codeload.github.com/acme/widgets/tar.gz/HEAD')).toBe(true);
  });

  it('says plainly that GitHub is rate-limiting downloads, and mentions the token only when there is none', async () => {
    const noToken = (await build({ archiveStatus: 429 }).catch((e: unknown) => e)) as LiveBuildError;
    expect(noToken.code).toBe('rate_limited');
    expect(noToken.message).toMatch(/rate-limiting downloads from this server's network/);
    expect(noToken.message).toMatch(/token on the server avoids this/);
    const withToken = (await build({ archiveStatus: 429, apiTarball: 'refuse' }, { token: 'tkn_abc' }).catch((e: unknown) => e)) as LiveBuildError;
    expect(withToken.code).toBe('rate_limited');
    expect(withToken.message).not.toMatch(/token on the server avoids this/);
    expect(withToken.message).not.toContain('tkn_abc');
  });

  it('derives the id from the latest commit when the archive has no commit id, and says so', async () => {
    const r = await build({ sha: null });
    expect(r.snapshot.sha).toBe(COMMIT_1);
    expect(r.snapshot.source!.notes.join(' ')).toMatch(/did not include the commit id/);
  });

  it('applies the file cap like the offline engine and marks the graph truncated', async () => {
    const r = await build({}, { maxFiles: 4 });
    expect(r.snapshot.truncated).toBe(true);
    expect(filePaths(r.snapshot)).toHaveLength(4);
    expect(r.snapshot.source!.notes.join(' ')).toMatch(/File cap: kept 4 files and left out 8/);
    // shallow code files are kept first, deep and test files go first
    expect(filePaths(r.snapshot)).not.toContain('tests/server.test.ts');
  });

  it('marks a partially read archive as truncated and says why', async () => {
    const many = { ...fixtureFiles(), ...Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`extra/f${i}.ts`, 'export const x = 1;'])) };
    const r = await build({ files: many }, { limits: { maxEntries: 50 } });
    expect(r.snapshot.truncated).toBe(true);
    expect(r.snapshot.source!.notes.join(' ')).toMatch(/Only part of the repo was read because the repo has more than 50 files/);
  });

  it('is tier 1 for a repo with no JavaScript, TypeScript or Python, with no approximation note', async () => {
    const r = await build({ files: { 'main.go': 'package main\nfunc main() {}\n', 'go.mod': 'module acme/widgets\n', 'README.md': '# Go\n' } });
    expect(r.snapshot.tier).toBe(1);
    expect(importEdges(r.snapshot)).toEqual([]);
    expect(r.snapshot.source!.notes.join(' ')).not.toMatch(/text scan/);
  });

  it('refuses an empty repo, or one with only binary files, with a clear message', async () => {
    const err = (await build({ files: { 'logo.png': Buffer.from([1, 2, 3]), 'package-lock.json': '{}' } }).catch((e: unknown) => e)) as LiveBuildError;
    expect(err).toBeInstanceOf(LiveBuildError);
    expect(err.code).toBe('failed');
    expect(err.message).toMatch(/no readable source files/);
  });

  it('maps a missing repo to not_found and does not call the GitHub API for a repo that cannot be downloaded', async () => {
    const reqs: Req[] = [];
    const err = (await build({ reqs, archiveStatus: 404 }).catch((e: unknown) => e)) as LiveBuildError;
    expect(err.code).toBe('not_found');
    expect(err.message).toMatch(/private repos are not supported/);
  });

  it('treats repo text as data: injected instructions only appear as quoted README text, never as notes or fields', async () => {
    const r = await build();
    const notes = r.snapshot.source!.notes.join(' ');
    expect(notes).not.toMatch(/ignore (all )?previous instructions/i);
    const root = r.snapshot.nodes.find((n) => n.id === 'dir:.')!;
    expect(JSON.stringify(root.meta.project)).toMatch(/Ignore all previous instructions/); // kept as README text, labelled untrusted by the tools
  });

  it('stays well inside the snapshot size budget', async () => {
    const r = await build();
    expect(r.report.bytes).toBeLessThan(200_000);
  });
});
