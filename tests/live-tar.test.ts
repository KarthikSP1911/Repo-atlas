import { describe, expect, it } from 'vitest';
import { TarParser, TarError, cleanTarPath, type TarFile } from '../src/services/live/tar.js';
import { DEFAULT_TARBALL_LIMITS, LiveBuildError, readTarball, tarballUrl, type TarballLimits } from '../src/services/live/fetch-tarball.js';
import { parseRepoSpec } from '../src/services/live/repo-spec.js';
import { fakeFetch, githubTar, paxEntry, tarEntry, tgz } from './helpers/tar.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function parseAll(tar: Buffer, chunk: number, decide: (p: string, size: number) => 'buffer' | 'count' | 'skip' = () => 'buffer') {
  const out: TarFile[] = [];
  const p = new TarParser({ decide: (i) => decide(i.path, i.size), onFile: (f) => out.push(f) });
  for (let i = 0; i < tar.length; i += chunk) p.push(tar.subarray(i, i + chunk));
  return { out, p };
}

describe('cleanTarPath', () => {
  it('strips the top folder and rejects hostile paths', () => {
    expect(cleanTarPath('repo-abc/src/a.ts')).toBe('src/a.ts');
    expect(cleanTarPath('repo-abc/')).toBeNull();
    expect(cleanTarPath('repo-abc')).toBeNull();
    expect(cleanTarPath('repo-abc/../etc/passwd')).toBeNull();
    expect(cleanTarPath('repo-abc/a/../../b')).toBeNull();
    expect(cleanTarPath('repo-abc/./a')).toBeNull();
    expect(cleanTarPath('/etc/passwd')).toBe('passwd'); // leading slash is just an empty segment; the first real segment is the "top folder"
    expect(cleanTarPath('repo-abc/a\\b')).toBeNull();
    expect(cleanTarPath(`repo-abc/${'x'.repeat(400)}`)).toBeNull();
    expect(cleanTarPath('repo-abc/a\u0001b')).toBeNull();
  });
});

describe('TarParser', () => {
  const tar = githubTar(
    { 'src/index.ts': "import './a';\nexport const x = 1;\n", 'src/a.ts': 'export const a = 1', 'README.md': '# Title\n', 'logo.bin': Buffer.from([1, 2, 0, 3, 4]), 'empty.txt': '' },
    SHA,
  );

  it.each([1, 7, 511, 512, 513, 4096, 1 << 20])('reads the same files with %i-byte chunks', (chunk) => {
    const { out, p } = parseAll(tar, chunk);
    expect(p.sha).toBe(SHA);
    expect(p.ended).toBe(true);
    expect(out.map((f) => f.path)).toEqual(['src/index.ts', 'src/a.ts', 'README.md', 'logo.bin', 'empty.txt']);
    expect(out[0]).toMatchObject({ text: "import './a';\nexport const x = 1;\n", binary: false, size: 34 });
    expect(out[3]).toMatchObject({ binary: true });
    expect(out[3].text).toBeUndefined();
    expect(out[4]).toMatchObject({ text: '', binary: false, size: 0 });
  });

  it("counts lines without keeping text when the decision is 'count'", () => {
    const { out } = parseAll(tar, 100, () => 'count');
    expect(out.find((f) => f.path === 'src/index.ts')).toMatchObject({ lines: 2, binary: false });
    expect(out.find((f) => f.path === 'src/index.ts')!.text).toBeUndefined();
    expect(out.find((f) => f.path === 'src/a.ts')).toMatchObject({ lines: 1 }); // last line without a newline still counts
  });

  it("does not report files whose decision is 'skip'", () => {
    const { out } = parseAll(tar, 512, (p) => (p.endsWith('.ts') ? 'skip' : 'buffer'));
    expect(out.map((f) => f.path)).toEqual(['README.md', 'logo.bin', 'empty.txt']);
  });

  it('ignores symlinks, hard links and directories, and drops paths that escape', () => {
    const t = Buffer.concat([
      paxEntry({ comment: SHA }, true),
      tarEntry('repo/link', '', '2'),
      tarEntry('repo/hard', '', '1'),
      tarEntry('repo/dir/', '', '5'),
      tarEntry('repo/../evil.txt', 'x'),
      tarEntry('repo/ok.txt', 'ok'),
      Buffer.alloc(1024),
    ]);
    const { out } = parseAll(t, 300);
    expect(out.map((f) => f.path)).toEqual(['ok.txt']);
  });

  it('uses the ustar prefix, pax path and GNU long names', () => {
    const longName = `${'d/'.repeat(60)}file.ts`; // over 100 characters
    const t = Buffer.concat([
      tarEntry('file.ts', 'a', '0', 'repo/deep/dir'),
      paxEntry({ path: `repo/pax/${longName}` }),
      tarEntry('placeholder', 'b'),
      tarEntry('././@LongLink', `repo/gnu/${longName}\0`, 'L'),
      tarEntry('truncated-name', 'c'),
      Buffer.alloc(1024),
    ]);
    const { out } = parseAll(t, 777);
    expect(out.map((f) => f.path)).toEqual(['deep/dir/file.ts', `pax/${longName}`, `gnu/${longName}`]);
  });

  it('rejects data that is not a tar file', () => {
    const p = new TarParser({ decide: () => 'skip', onFile: () => undefined });
    expect(() => p.push(Buffer.alloc(512, 65))).toThrow(TarError);
  });

  it('refuses oversized metadata blocks', () => {
    const big = tarEntry('x', 'y'.repeat(70_000), 'x');
    const p = new TarParser({ decide: () => 'skip', onFile: () => undefined });
    expect(() => p.push(big)).toThrow(/oversized/);
  });
});

describe('readTarball', () => {
  const spec = parseRepoSpec('acme/widgets')!;
  const limits = (over: Partial<TarballLimits> = {}): TarballLimits => ({ ...DEFAULT_TARBALL_LIMITS, deadlineAt: Date.now() + 30_000, ...over });
  const handlers = (out: string[]) => ({ decide: () => 'buffer' as const, onFile: (f: TarFile) => void out.push(f.path) });
  const archive = githubTar({ 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c' }, SHA);
  // Large enough to arrive in several decompression chunks (limits are checked between chunks).
  const big = githubTar(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}.ts`, 'x'])), SHA);

  it('builds the codeload URL from a validated spec only', () => {
    expect(tarballUrl(spec)).toBe('https://codeload.github.com/acme/widgets/tar.gz/HEAD');
  });

  it('reads the files and the commit id', async () => {
    const seen: string[] = [];
    const out: string[] = [];
    const r = await readTarball(spec, handlers(out), limits(), fakeFetch({ 'https://codeload.github.com/acme/widgets/tar.gz/HEAD': () => tgz(archive) }, seen));
    expect(out).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(r).toMatchObject({ sha: SHA, filesSeen: 3, truncated: false });
    expect(seen).toEqual(['https://codeload.github.com/acme/widgets/tar.gz/HEAD']);
  });

  it('follows a redirect to another codeload path', async () => {
    const out: string[] = [];
    const f = fakeFetch({
      'https://codeload.github.com/acme/widgets/': () => new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/acme/renamed/tar.gz/HEAD' } }),
    });
    const f2 = fakeFetch({
      'https://codeload.github.com/acme/widgets/': () => new Response(null, { status: 302, headers: { location: '/acme/renamed/tar.gz/HEAD' } }),
      'https://codeload.github.com/acme/renamed/': () => tgz(archive),
    });
    await expect(readTarball(spec, handlers(out), limits(), f)).rejects.toThrow(); // the second hop is not routed (599)
    await readTarball(spec, handlers(out), limits(), f2);
    expect(out).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('refuses a redirect to any other host', async () => {
    const f = fakeFetch({ 'https://codeload.github.com/': () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.tgz' } }) });
    await expect(readTarball(spec, handlers([]), limits(), f)).rejects.toMatchObject({ code: 'upstream', message: expect.stringMatching(/unexpected host/) });
  });

  it('gives up after too many redirects', async () => {
    const f = fakeFetch({ 'https://codeload.github.com/': () => new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/loop' } }) });
    await expect(readTarball(spec, handlers([]), limits(), f)).rejects.toMatchObject({ code: 'upstream' });
  });

  it.each([
    [404, 'not_found', /no public repo acme\/widgets/],
    [403, 'rate_limited', /rate-limiting downloads/],
    [429, 'rate_limited', /rate-limiting downloads/],
    [500, 'upstream', /HTTP 500/],
  ])('maps HTTP %i to %s', async (status, code, message) => {
    const f = fakeFetch({ 'https://codeload.github.com/': () => new Response('x', { status }) });
    const err = (await readTarball(spec, handlers([]), limits(), f).catch((e: unknown) => e)) as LiveBuildError;
    expect(err).toBeInstanceOf(LiveBuildError);
    expect(err.code).toBe(code);
    expect(err.message).toMatch(message);
  });

  it('says so when GitHub cannot be reached', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(readTarball(spec, handlers([]), limits(), f)).rejects.toMatchObject({ code: 'upstream', message: expect.stringMatching(/Could not reach GitHub/) });
  });

  it('stops, rather than fails, at the file-count limit', async () => {
    const out: string[] = [];
    const r = await readTarball(spec, handlers(out), limits({ maxEntries: 1 }), fakeFetch({ 'https://codeload.github.com/': () => tgz(big) }));
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toMatch(/more than 1 files/);
  });

  it('stops at the decompressed-size limit (decompression bomb guard)', async () => {
    const bomb = githubTar({ 'zeros.txt': Buffer.alloc(2_000_000, 0x61) }, SHA);
    const out: string[] = [];
    const r = await readTarball(spec, { decide: () => 'skip', onFile: () => undefined }, limits({ maxUncompressedBytes: 100_000 }), fakeFetch({ 'https://codeload.github.com/': () => tgz(bomb) }));
    expect(out).toEqual([]);
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toMatch(/expands past/);
    expect(r.uncompressedBytes).toBeLessThan(1_000_000);
  });

  it('stops at the deadline', async () => {
    const r = await readTarball(spec, handlers([]), limits({ deadlineAt: Date.now() - 1 }), fakeFetch({ 'https://codeload.github.com/': () => tgz(big) }));
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toMatch(/time limit/);
  });

  it('reports a damaged download instead of returning half of it as complete', async () => {
    const good = tgz(archive);
    const bytes = new Uint8Array(await good.arrayBuffer());
    const cut = new Response(bytes.subarray(0, Math.floor(bytes.length / 2)), { status: 200 });
    await expect(readTarball(spec, handlers([]), limits(), fakeFetch({ 'https://codeload.github.com/': () => cut }))).rejects.toMatchObject({ code: 'upstream' });
  });

  it('reports a body that is not a gzip tar', async () => {
    const f = fakeFetch({ 'https://codeload.github.com/': () => new Response('<html>nope</html>', { status: 200 }) });
    await expect(readTarball(spec, handlers([]), limits(), f)).rejects.toMatchObject({ code: 'upstream' });
  });
});
