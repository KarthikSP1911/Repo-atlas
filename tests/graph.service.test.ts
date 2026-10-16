import { describe, expect, it } from 'vitest';
import {
  analyze,
  analyzeDocs,
  detectEntries,
  detectProject,
  exportTargets,
  isConfigPath,
  isTestPath,
  tagsFor,
} from '../src/services/graph.service.js';
import { BULK_FILES, type HistoryCommit } from '../src/services/link.service.js';
import { langOf, type ParsedFile } from '../src/services/parse.service.js';

function pf(p: string, imports: string[] = [], extra: Partial<ParsedFile> = {}): ParsedFile {
  return { path: p, lang: langOf(p), loc: 10, imports: imports.map((to) => ({ to, weight: 1 })), exports: [], symbols: [], signals: {}, ...extra };
}
const filesOf = (...fs: ParsedFile[]): Map<string, ParsedFile> => new Map(fs.map((f) => [f.path, f]));
const commit = (n: number, author: string, files: string[], date = '2026-10-01T00:00:00Z', bulk = false): HistoryCommit => ({
  sha: n.toString(16).padStart(40, '0'), subject: `c${n}`, date, author, files, fixes: [], bulk,
});

describe('classification helpers', () => {
  it.each([
    ['tests/a.py', true], ['src/__tests__/x.ts', true], ['src/a.test.ts', true], ['pkg/test_core.py', true], ['pkg/core_test.go', true],
    ['src/FooTest.java', true], ['src/a.ts', false], ['src/latest.ts', false], ['src/contest/a.ts', false],
  ])('isTestPath(%s) = %s', (p, expected) => expect(isTestPath(p)).toBe(expected));

  it.each([
    ['package.json', true], ['tsconfig.build.json', true], ['src/config.ts', true], ['app/settings.py', true], ['Dockerfile', true],
    ['.github/workflows/ci.yml', true], ['vite.config.ts', true], ['requirements-dev.txt', true], ['.env.example', true],
    ['src/server.ts', false], ['src/configure-thing.ts', false], ['README.md', false],
  ])('isConfigPath(%s) = %s', (p, expected) => expect(isConfigPath(p)).toBe(expected));

  it('tagsFor assigns role tags from paths', () => {
    expect(tagsFor('src/routes/users.ts')).toEqual(['route']);
    expect(tagsFor('src/db/client.ts')).toEqual(['model']);
    expect(tagsFor('tests/users.test.ts')).toEqual(['test']);
    expect(tagsFor('src/config.ts')).toEqual(['config']);
    expect(tagsFor('docs/guide.md')).toEqual(['docs']);
  });
});

describe('metrics', () => {
  const files = filesOf(
    pf('a.ts', ['b.ts']), pf('c.ts', ['b.ts']), pf('b.ts', ['d.ts']), pf('d.ts'), pf('lonely.ts'),
  );
  const r = analyze({ files, commits: [], texts: new Map(), lockfiles: [] });

  it('computes fan-in and fan-out', () => {
    expect(r.files.get('b.ts')).toMatchObject({ fanIn: 2, fanOut: 1 });
    expect(r.files.get('a.ts')).toMatchObject({ fanIn: 0, fanOut: 1 });
    expect(r.files.get('d.ts')).toMatchObject({ fanIn: 1, fanOut: 0 });
  });

  it('blends fan-in and PageRank into a 0..1 centrality; isolated files get 0', () => {
    const c = [...r.files.values()].map((f) => f.centrality);
    expect(Math.max(...c)).toBeGreaterThan(0.9);
    expect(c.every((x) => x >= 0 && x <= 1)).toBe(true);
    expect(r.files.get('lonely.ts')!.centrality).toBe(0);
    expect(r.files.get('b.ts')!.centrality).toBeGreaterThan(r.files.get('a.ts')!.centrality);
  });

  it('handles a repo with no imports', () => {
    const none = analyze({ files: filesOf(pf('a.go'), pf('b.go')), commits: [], texts: new Map(), lockfiles: [] });
    expect([...none.files.values()].every((f) => f.centrality === 0 && f.fanIn === 0)).toBe(true);
  });
});

describe('regressions found on real repos (ky, click)', () => {
  it('reads the package.json "exports" field and maps distribution/ back to source/', () => {
    const files = filesOf(pf('source/index.ts'), pf('source/other.ts'));
    const texts = new Map([['package.json', JSON.stringify({ exports: { types: './distribution/index.d.ts', default: './distribution/index.js' } })]]);
    const e = detectEntries(files, texts);
    expect(e.map((x) => x.path)).toEqual(['source/index.ts']);
    expect(e[0].reasons).toContain('package.json exports');
    const nested = detectEntries(filesOf(pf('src/main.ts')), new Map([['package.json', JSON.stringify({ exports: { '.': { import: './dist/main.js' }, './sub': './dist/sub.js' } })]]));
    expect(nested.map((x) => x.path)).toEqual(['src/main.ts']);
    expect(exportTargets('./a.js')).toEqual(['./a.js']);
    expect(exportTargets({ '.': { import: './i.js', require: './r.cjs' } })).toEqual(['./i.js', './r.cjs']);
    expect(exportTargets(null)).toEqual([]);
  });

  it('does not treat examples, docs or fixtures as the project entry points', () => {
    const go = filesOf(pf('_examples/blame/main.go', [], { signals: { goMain: true } }), pf('cmd/tool/main.go', [], { signals: { goMain: true } }));
    expect(detectEntries(go, new Map()).map((e) => e.path)).toEqual(['cmd/tool/main.go']);
    const files = filesOf(pf('examples/a/app.py', [], { signals: { mainGuard: true } }), pf('docs/demo/server.js', [], { signals: { listen: true } }), pf('src/lib/core.py'));
    const texts = new Map([['pyproject.toml', '[project.scripts]\nex = "examples.a.app:main"\n']]);
    expect(detectEntries(files, texts)).toEqual([]);
  });

  it('takes frameworks from runtime dependencies, not devDependencies (tooling excepted)', () => {
    const files = filesOf(pf('a.ts'));
    const texts = new Map([['package.json', JSON.stringify({ dependencies: { zod: '^3' }, devDependencies: { express: '^4', vitest: '^1', typescript: '^5' } })]]);
    const p = detectProject(files, texts, []);
    expect(p.stack).toEqual(['TypeScript', 'Vitest', 'Zod']);
  });

  it('lists only programming languages', () => {
    const files = filesOf(pf('a.py'), pf('b.toml'), pf('c.ini'), pf('d.md'), pf('e.typed'), pf('f.sh'));
    expect(detectProject(files, new Map(), []).languages).toEqual({ py: 1, shell: 1 });
  });

  it('keeps test files out of centrality and fan-in', () => {
    const files = filesOf(
      pf('src/core.ts'), pf('src/a.ts', ['src/core.ts']), pf('src/b.ts', ['src/core.ts']),
      pf('tests/helpers/server.ts'),
      pf('tests/a.test.ts', ['tests/helpers/server.ts', 'src/core.ts']), pf('tests/b.test.ts', ['tests/helpers/server.ts', 'src/core.ts']), pf('tests/c.test.ts', ['tests/helpers/server.ts']),
    );
    const r = analyze({ files, commits: [], texts: new Map(), lockfiles: [] });
    expect(r.files.get('src/core.ts')).toMatchObject({ fanIn: 2 }); // not 4: tests do not count
    expect(r.files.get('tests/helpers/server.ts')!.centrality).toBe(0);
    expect(r.files.get('src/core.ts')!.centrality).toBe(Math.max(...[...r.files.values()].map((f) => f.centrality)));
    expect(r.files.get('tests/a.test.ts')!.fanOut).toBe(2); // fan-out still reports what a test imports
  });

  it('weights direct fan-in over PageRank so a sink behind one hub does not outrank a hub', () => {
    // leaf <- hub <- many; PageRank alone would rank `leaf` above `hub`.
    const importers = Array.from({ length: 6 }, (_, i) => pf(`src/u${i}.ts`, ['src/hub.ts']));
    const files = filesOf(pf('src/leaf.ts'), pf('src/hub.ts', ['src/leaf.ts']), ...importers);
    const r = analyze({ files, commits: [], texts: new Map(), lockfiles: [] });
    expect(r.files.get('src/hub.ts')!.centrality).toBeGreaterThan(r.files.get('src/leaf.ts')!.centrality);
  });

  it('constants files are not config', () => {
    expect(isConfigPath('source/core/constants.ts')).toBe(false);
    expect(isConfigPath('src/settings.ts')).toBe(true);
  });
});

describe('test association', () => {
  it('links tests by imports and by mirrored names', () => {
    const files = filesOf(
      pf('src/users/service.ts'), pf('src/orders/service.ts'), pf('src/util.ts'),
      pf('tests/users/service.test.ts'), pf('tests/orders/service.test.ts'),
      pf('tests/util.spec.ts', ['src/util.ts']),
      pf('pkg/core.py'), pf('tests/test_core.py'),
    );
    const r = analyze({ files, commits: [], texts: new Map(), lockfiles: [] });
    expect(r.files.get('tests/users/service.test.ts')!.testFor).toEqual(['src/users/service.ts']);
    expect(r.files.get('tests/orders/service.test.ts')!.testFor).toEqual(['src/orders/service.ts']);
    expect(r.files.get('tests/util.spec.ts')!.testFor).toEqual(['src/util.ts']);
    expect(r.files.get('tests/test_core.py')!.testFor).toEqual(['pkg/core.py']);
    expect(r.files.get('src/users/service.ts')!.testedBy).toEqual(['tests/users/service.test.ts']);
    expect(r.files.get('src/orders/service.ts')!.isTest).toBe(false);
  });
});

describe('entry points', () => {
  it('uses package.json main (dist->src), scripts and bin', () => {
    const files = filesOf(pf('src/index.ts'), pf('src/server.ts'), pf('src/cli.ts'), pf('src/lib.ts'));
    const texts = new Map([['package.json', JSON.stringify({ main: 'dist/index.js', bin: { tool: './dist/cli.js' }, scripts: { start: 'node dist/server.js', build: 'tsc' } })]]);
    const e = detectEntries(files, texts);
    const byPath = Object.fromEntries(e.map((x) => [x.path, x]));
    expect(Object.keys(byPath).sort()).toEqual(['src/cli.ts', 'src/index.ts', 'src/server.ts']);
    expect(byPath['src/server.ts']).toMatchObject({ kind: 'server', command: 'npm run start' });
    expect(byPath['src/cli.ts'].kind).toBe('cli');
    expect(byPath['src/index.ts'].reasons).toContain('package.json main');
  });

  it('uses .listen(), __main__ guards, Go main, pyproject scripts and conventional names', () => {
    const files = filesOf(
      pf('app/web.js', [], { signals: { listen: true } }),
      pf('tools/run_job.py', [], { signals: { mainGuard: true } }),
      pf('cmd/api/main.go', [], { signals: { goMain: true } }),
      pf('mylib/cli.py'), pf('mylib/__init__.py'), pf('main.py'),
      pf('tests/test_main.py', [], { signals: { mainGuard: true } }),
      pf('src/deep/nested/index.ts'),
    );
    const texts = new Map([['pyproject.toml', '[project.scripts]\nmytool = "mylib.cli:main"\n']]);
    const e = detectEntries(files, texts);
    const paths = e.map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(['app/web.js', 'tools/run_job.py', 'cmd/api/main.go', 'mylib/cli.py', 'main.py']));
    expect(paths).not.toContain('tests/test_main.py');
    expect(paths).not.toContain('src/deep/nested/index.ts');
    expect(e.find((x) => x.path === 'mylib/cli.py')!.reasons).toContain('pyproject console script');
    expect(e.find((x) => x.path === 'app/web.js')!.kind).toBe('server');
  });

  it('returns nothing when there is no signal', () => {
    expect(detectEntries(filesOf(pf('a.ts'), pf('b.ts')), new Map())).toEqual([]);
  });
});

describe('docs', () => {
  const files = filesOf(
    pf('README.md'), pf('docs/architecture.md'),
    pf('src/users/service.ts'), pf('src/orders/service.ts'), pf('src/payment-gateway.ts'), pf('src/db/client.ts'), pf('settings.py'),
  );
  const texts = new Map([
    ['README.md', '# Shop\n\nStart in `src/users/service.ts`. See payment-gateway.ts for billing, and the code in src/db/ for storage.\nAlso `settings.py` holds env.'],
    ['docs/architecture.md', 'Mentions service.ts only by basename (ambiguous).'],
  ]);

  it('links exact paths, unique basenames as likely, and directories', () => {
    const docs = analyzeDocs(files, texts);
    const readme = docs.find((d) => d.path === 'README.md')!;
    expect(readme.title).toBe('Shop');
    expect(readme.describes).toEqual(expect.arrayContaining([
      { path: 'src/users/service.ts', isDir: false, confidence: 'exact' },
      { path: 'src/payment-gateway.ts', isDir: false, confidence: 'likely' },
      { path: 'src/db', isDir: true, confidence: 'exact' },
      { path: 'settings.py', isDir: false, confidence: 'exact' },
    ]));
    expect(readme.describes.find((d) => d.path === 'src/orders/service.ts')).toBeUndefined();
    expect(docs.find((d) => d.path === 'docs/architecture.md')!.describes).toEqual([]); // ambiguous basename is not linked
  });

  it('counts only exact file mentions in docsMentions', () => {
    const r = analyze({ files, commits: [], texts, lockfiles: [] });
    expect(r.files.get('src/users/service.ts')!.docsMentions).toBe(1);
    expect(r.files.get('src/payment-gateway.ts')!.docsMentions).toBe(0);
  });
});

describe('history metrics', () => {
  const files = filesOf(pf('a.ts'), pf('b.ts'), pf('c.ts'));
  const commits = [
    commit(1, 'Alice', ['a.ts', 'b.ts'], '2026-10-10T00:00:00Z'),
    commit(2, 'Alice', ['a.ts', 'b.ts'], '2026-10-09T00:00:00Z'),
    commit(3, 'Bob', ['a.ts'], '2024-01-01T00:00:00Z'),
    commit(4, 'dependabot[bot]', ['a.ts', 'c.ts'], '2026-10-08T00:00:00Z'),
    commit(5, 'Carol', Array.from({ length: BULK_FILES + 1 }, (_, i) => `x${i}`).concat(['c.ts']), '2026-10-07T00:00:00Z', true),
  ];
  const r = analyze({ files, commits, texts: new Map(), lockfiles: [] });

  it('counts churn, ignores bulk commits and tracks last change', () => {
    expect(r.files.get('a.ts')).toMatchObject({ churn: 4, lastChangedAt: '2026-10-10T00:00:00Z' });
    expect(r.files.get('c.ts')!.churn).toBe(1); // dependabot only; the bulk commit is skipped
  });

  it('ranks owners by recency-weighted activity and excludes bots', () => {
    expect(r.files.get('a.ts')!.owners).toEqual(['person:alice', 'person:bob']);
    expect(r.files.get('c.ts')!.owners).toEqual([]);
  });

  it('records people and co-change pairs seen at least twice', () => {
    expect(r.persons.get('person:dependabot-bot')).toMatchObject({ bot: true, commits: 1 });
    expect(r.persons.get('person:alice')).toMatchObject({ bot: false, commits: 2 });
    expect(r.coChange).toEqual([{ a: 'a.ts', b: 'b.ts', count: 2 }]);
  });
});

describe('project facts', () => {
  it('reads package.json, stack hints, package manager and README excerpt', () => {
    const files = filesOf(pf('src/index.ts'), pf('src/a.py'), pf('README.md'));
    const texts = new Map([
      ['package.json', JSON.stringify({ name: 'shop', description: 'A shop API', license: 'MIT', scripts: { start: 'node dist/index.js', test: 'vitest', secret: 'x' }, dependencies: { express: '^4', zod: '^3' }, devDependencies: { vitest: '^1', typescript: '^5' }, workspaces: ['packages/*'] })],
      ['README.md', '# Sample Shop\n\n[![ci](x)](y)\n\nA small API that serves a product catalogue with orders and users.\n\n## Install'],
      ['requirements.txt', 'flask==3.0\nRequests>=2\n# comment'],
    ]);
    const p = detectProject(files, texts, ['pnpm-lock.yaml']);
    expect(p).toMatchObject({ name: 'shop', description: 'A shop API', license: 'MIT', packageManager: 'pnpm', workspaces: ['packages/*'], readmeTitle: 'Sample Shop' });
    expect(p.scripts).toEqual({ start: 'node dist/index.js', test: 'vitest' });
    expect(p.stack).toEqual(expect.arrayContaining(['Express', 'Zod', 'Vitest', 'TypeScript', 'Flask', 'requests']));
    expect(p.languages).toEqual({ ts: 1, py: 1 });
    expect(p.readmeExcerpt).toMatch(/^A small API that serves/);
  });
});
