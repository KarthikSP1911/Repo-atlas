import Graph from 'graphology';
import pagerank from 'graphology-metrics/centrality/pagerank.js';
import type { HistoryCommit } from './link.service.js';
import { isBot, personSlug } from './link.service.js';
import { dirOf, join, probeFile, type ParsedFile } from './parse.service.js';

/**
 * OFFLINE ONLY. Turns parsed files, history and a few text files into the metrics the snapshot
 * stores: fan-in, fan-out, PageRank centrality, churn, owners, test association, entry points,
 * config and role tags, doc-to-code links and project facts. Pure functions, no I/O.
 */

export interface FileAnalysis {
  fanIn: number;
  fanOut: number;
  /** PageRank over import edges, scaled so the top file is 1. 0 when there are no import edges. */
  centrality: number;
  churn: number;
  lastChangedAt?: string;
  /** `person:<slug>` ids, most active first (bots excluded). */
  owners: string[];
  isEntry: boolean;
  isConfig: boolean;
  isTest: boolean;
  testFor: string[];
  testedBy: string[];
  docsMentions: number;
  tags: string[];
}

export interface EntryInfo {
  path: string;
  kind: 'server' | 'cli' | 'main' | 'lib-index';
  /** Why this file was picked, e.g. `package.json main`, `scripts.start`, `.listen() call`. */
  reasons: string[];
  /** A command that starts it, when known (for example `npm start`). */
  command?: string;
  score: number;
}

export interface DocInfo {
  path: string;
  title: string;
  describes: { path: string; isDir: boolean; confidence: 'exact' | 'likely' }[];
}

export interface ProjectInfo {
  name?: string;
  description?: string;
  license?: string;
  packageManager?: string;
  languages: Record<string, number>;
  scripts: Record<string, string>;
  stack: string[];
  dependencies: string[];
  workspaces: string[];
  /** First paragraph of the README. Untrusted text. */
  readmeTitle?: string;
  readmeExcerpt?: string;
}

export interface CoChange {
  a: string;
  b: string;
  count: number;
}

export interface PersonInfo {
  id: string;
  name: string;
  commits: number;
  bot: boolean;
}

export interface Analysis {
  files: Map<string, FileAnalysis>;
  entries: EntryInfo[];
  docs: DocInfo[];
  project: ProjectInfo;
  coChange: CoChange[];
  persons: Map<string, PersonInfo>;
}

export interface AnalyzeInput {
  files: Map<string, ParsedFile>;
  commits: HistoryCommit[];
  /** Text of package.json, pyproject.toml, requirements*.txt, go.mod, Cargo.toml and markdown docs. */
  texts: Map<string, string>;
  lockfiles: string[];
}

// --- Classification ----------------------------------------------------------

const TEST_DIR_RE = /(^|\/)(tests?|__tests__|spec|specs|e2e|integration-tests?)(\/|$)/i;
const TEST_NAME_RE = /(\.(test|spec)\.[a-z]+$)|(_test\.(go|py|rs|rb|exs?)$)|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs)$|_spec\.rb$/i;

export function isTestPath(p: string): boolean {
  return TEST_DIR_RE.test(p) || TEST_NAME_RE.test(p);
}

const CONFIG_BASENAMES = new Set([
  'package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'pipfile', 'go.mod', 'cargo.toml', 'pom.xml',
  'makefile', 'dockerfile', 'procfile', '.env.example', '.env.sample', '.env.template', 'justfile', 'gemfile',
  'composer.json', 'mix.exs', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'deno.json', 'nitrostack.json',
]);
const CONFIG_PATTERNS = [
  /^tsconfig[\w.-]*\.json$/i, /^jsconfig\.json$/i, /^requirements[\w.-]*\.txt$/i, /^docker-compose[\w.-]*\.ya?ml$/i,
  /^\.?(eslint|prettier|babel|stylelint)(rc|\.config)[\w.]*$/i, /^(vite|vitest|webpack|rollup|jest|next|nuxt|tailwind|postcss|astro|svelte|playwright|cypress|esbuild|tsup)\.config\.[\w.]+$/i,
  /^\.?(editorconfig|npmrc|nvmrc|python-version|tool-versions|dockerignore)$/i,
];
const CONFIG_STEMS = new Set(['config', 'configuration', 'settings', 'env']);

export function isConfigPath(p: string): boolean {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const lower = base.toLowerCase();
  if (CONFIG_BASENAMES.has(lower) || CONFIG_PATTERNS.some((re) => re.test(base))) return true;
  if (/(^|\/)\.github\/workflows\//.test(p) || /(^|\/)(config|configs|settings)\//i.test(p)) return true;
  const stem = lower.replace(/\.[^.]+$/, '');
  return CONFIG_STEMS.has(stem) && /\.(ts|js|mjs|cjs|py|json|ya?ml|toml|go|rs|java|rb)$/.test(lower);
}

const TAG_RULES: [string, RegExp][] = [
  ['route', /(^|\/)(routes?|routers?|controllers?|handlers?|endpoints?|api|views|urls)(\/|\.|$)/i],
  ['model', /(^|\/)(models?|schemas?|entities|entity|migrations?|db|database|orm|prisma)(\/|\.|$)/i],
  ['service', /(^|\/)(services?|usecases?|domain|core)(\/|\.|$)/i],
  ['util', /(^|\/)(utils?|helpers?|lib|common|shared|tools)(\/|\.|$)/i],
  ['ui', /(^|\/)(components?|pages?|screens?|ui|widgets?|templates?|static|public)(\/|\.|$)/i],
  ['script', /(^|\/)(scripts?|bin|tools|cmd)(\/|$)/i],
  ['docs', /(^|\/)(docs?|documentation|examples?)(\/|$)|\.mdx?$/i],
  ['infra', /(^|\/)(infra|deploy|deployment|terraform|k8s|helm|ansible|\.github)(\/|$)|dockerfile/i],
];

export function tagsFor(p: string): string[] {
  const tags = TAG_RULES.filter(([, re]) => re.test(p)).map(([t]) => t);
  if (isTestPath(p)) tags.push('test');
  if (isConfigPath(p)) tags.push('config');
  return [...new Set(tags)];
}

// --- Metrics -------------------------------------------------------------------

/** Import graph without edges that start in test files, so tests never inflate a module's rank. */
function importGraph(files: Map<string, ParsedFile>): Graph {
  const g = new Graph({ type: 'directed', multi: false });
  for (const p of files.keys()) g.addNode(p);
  for (const f of files.values()) {
    if (isTestPath(f.path)) continue;
    for (const imp of f.imports) if (g.hasNode(imp.to) && !g.hasDirectedEdge(f.path, imp.to)) g.addDirectedEdge(f.path, imp.to, { weight: imp.weight });
  }
  return g;
}

/** Weight of direct fan-in in the centrality score; the rest is PageRank (see DECISIONS D15). */
export const CENTRALITY_FANIN_WEIGHT = 0.7;

const stemOf = (p: string): string =>
  p
    .slice(p.lastIndexOf('/') + 1)
    .replace(/\.[^.]+$/, '')
    .replace(/(\.(test|spec))$|(_test|_spec|Tests?)$/i, '')
    .replace(/^test_/i, '')
    .toLowerCase();

function commonSuffix(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function associateTests(files: Map<string, ParsedFile>): { testFor: Map<string, string[]>; testedBy: Map<string, string[]> } {
  const isTest = new Map([...files.keys()].map((p) => [p, isTestPath(p)]));
  const sources = [...files.values()].filter((f) => !isTest.get(f.path) && (f.lang !== 'markdown' && f.lang !== 'json' && f.lang !== 'yaml' && f.lang !== 'text'));
  const byStem = new Map<string, string[]>();
  for (const s of sources) {
    const k = stemOf(s.path);
    byStem.set(k, [...(byStem.get(k) ?? []), s.path]);
  }
  const testFor = new Map<string, string[]>();
  const testedBy = new Map<string, string[]>();
  for (const f of files.values()) {
    if (!isTest.get(f.path)) continue;
    const targets = new Set<string>();
    for (const imp of f.imports) if (files.has(imp.to) && !isTest.get(imp.to) && files.get(imp.to)!.lang === f.lang) targets.add(imp.to);
    const named = (byStem.get(stemOf(f.path)) ?? []).filter((c) => c !== f.path);
    if (named.length) {
      const testParts = dirOf(f.path).split('/').filter((x) => x && !TEST_DIR_RE.test(`${x}/`));
      const scored = named.map((c) => ({ c, s: commonSuffix(dirOf(c).split('/'), testParts) })).sort((a, b) => b.s - a.s || a.c.localeCompare(b.c));
      for (const x of scored.filter((y) => y.s === scored[0].s).slice(0, 3)) targets.add(x.c);
    }
    const list = [...targets].sort().slice(0, 5);
    if (list.length) testFor.set(f.path, list);
    for (const t of list) testedBy.set(t, [...(testedBy.get(t) ?? []), f.path]);
  }
  for (const [k, v] of testedBy) testedBy.set(k, [...new Set(v)].sort().slice(0, 5));
  return { testFor, testedBy };
}

function historyMetrics(files: Map<string, ParsedFile>, commits: HistoryCommit[]) {
  const newest = commits.reduce((m, c) => (c.date > m ? c.date : m), '');
  const newestMs = newest ? Date.parse(newest) : 0;
  const churn = new Map<string, number>();
  const last = new Map<string, string>();
  const authorScore = new Map<string, Map<string, number>>();
  const persons = new Map<string, PersonInfo>();
  const pairs = new Map<string, number>();

  for (const c of commits) {
    const id = `person:${personSlug(c.author)}`;
    const person = persons.get(id) ?? { id, name: c.author, commits: 0, bot: isBot(c.author) };
    person.commits++;
    persons.set(id, person);
    if (c.bulk) continue;
    const ageDays = newestMs ? Math.max(0, (newestMs - Date.parse(c.date)) / 86_400_000) : 0;
    const weight = 0.5 ** (ageDays / 180);
    const touched = c.files.filter((f) => files.has(f));
    for (const f of touched) {
      churn.set(f, (churn.get(f) ?? 0) + 1);
      if (!last.has(f) || c.date > last.get(f)!) last.set(f, c.date);
      if (!person.bot) {
        const m = authorScore.get(f) ?? new Map<string, number>();
        m.set(id, (m.get(id) ?? 0) + weight);
        authorScore.set(f, m);
      }
    }
    if (touched.length >= 2 && touched.length <= 12) {
      const sorted = [...touched].sort();
      for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) pairs.set(`${sorted[i]}\0${sorted[j]}`, (pairs.get(`${sorted[i]}\0${sorted[j]}`) ?? 0) + 1);
    }
  }
  const owners = new Map<string, string[]>();
  for (const [f, m] of authorScore) owners.set(f, [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([id]) => id));
  const coChange: CoChange[] = [...pairs.entries()]
    .filter(([, n]) => n >= 2)
    .map(([k, count]) => {
      const [a, b] = k.split('\0');
      return { a, b, count };
    })
    .sort((x, y) => y.count - x.count || x.a.localeCompare(y.a))
    .slice(0, 20);
  return { churn, last, owners, persons, coChange };
}

// --- Entry points ----------------------------------------------------------------

const CONVENTIONAL = /^(index|main|app|server|cli|run|manage|wsgi|asgi|__main__)\.(ts|tsx|js|mjs|cjs|py)$/;
/** String targets in a package.json `exports` field for the root entry (".") or bare conditions. */
export function exportTargets(exp: unknown, depth = 0): string[] {
  if (typeof exp === 'string') return [exp];
  if (!exp || typeof exp !== 'object' || depth > 4) return [];
  const obj = exp as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.some((k) => k.startsWith('.'))) return exportTargets(obj['.'], depth + 1);
  return ['import', 'node', 'default', 'require'].flatMap((k) => exportTargets(obj[k], depth + 1));
}

const NON_PRODUCT_DIR = /(^|\/)_?(examples?|samples?|demos?|cookbook|docs?|benchmarks?|fixtures?)\//i;

const JS_RUN_RE = /(?:node|tsx|ts-node|nodemon|bun(?: run)?|deno run)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w./@-]+\.(?:[cm]?[jt]sx?))/;

function resolveFromPackage(pkgDir: string, target: string, allPaths: Set<string>): string | undefined {
  const t = target.replace(/^\.\//, '');
  return probeFile(join(pkgDir, t), allPaths) ?? probeFile(join(pkgDir, t.replace(/^(dist|distribution|build|lib|out|esm|cjs)\//, 'src/')), allPaths) ?? probeFile(join(pkgDir, t.replace(/^(dist|distribution|build|lib|out|esm|cjs)\//, 'source/')), allPaths);
}

export function detectEntries(files: Map<string, ParsedFile>, texts: Map<string, string>): EntryInfo[] {
  const allPaths = new Set(files.keys());
  const found = new Map<string, EntryInfo>();
  const add = (p: string | undefined, kind: EntryInfo['kind'], reason: string, score: number, command?: string): void => {
    if (!p || !allPaths.has(p) || isTestPath(p)) return;
    if (NON_PRODUCT_DIR.test(p)) score -= 8; // examples and docs are not the project's own entry points
    const cur = found.get(p);
    if (cur) {
      cur.reasons.push(reason);
      cur.score = Math.max(cur.score, score) + 0.5;
      if (!cur.command && command) cur.command = command;
      if (kind === 'server' || (kind === 'cli' && cur.kind !== 'server')) cur.kind = kind;
    } else {
      found.set(p, { path: p, kind, reasons: [reason], score, command });
    }
  };

  // package.json: main, bin, scripts.start/dev
  for (const [tp, text] of texts) {
    if (!/(^|\/)package\.json$/.test(tp)) continue;
    const dir = dirOf(tp);
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    const prefix = dir === '' ? 'npm' : `npm --prefix ${dir}`;
    if (typeof pkg.main === 'string') add(resolveFromPackage(dir, pkg.main, allPaths), 'main', 'package.json main', 10);
    for (const t of exportTargets(pkg.exports).slice(0, 4)) {
      if (!/\.(d\.ts|json|css)$/.test(t)) add(resolveFromPackage(dir, t, allPaths), 'main', 'package.json exports', 9);
    }
    if (typeof pkg.module === 'string' && !pkg.main && !pkg.exports) add(resolveFromPackage(dir, pkg.module, allPaths), 'lib-index', 'package.json module', 7);
    const bin = pkg.bin;
    for (const b of typeof bin === 'string' ? [bin] : bin && typeof bin === 'object' ? Object.values(bin as Record<string, string>) : []) {
      if (typeof b === 'string') add(resolveFromPackage(dir, b, allPaths), 'cli', 'package.json bin', 10);
    }
    const scripts = (pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, string>;
    for (const name of ['start', 'dev', 'serve', 'start:prod']) {
      const m = typeof scripts[name] === 'string' ? JS_RUN_RE.exec(scripts[name]) : null;
      if (m) add(resolveFromPackage(dir, m[1], allPaths), 'server', `scripts.${name}`, 9, `${prefix} run ${name}`);
    }
  }

  // Python console scripts and Go/Rust/Java mains.
  for (const [tp, text] of texts) {
    if (!/(^|\/)pyproject\.toml$/.test(tp)) continue;
    const section = /\[(?:project|tool\.poetry)\.scripts\]([\s\S]*?)(?:\n\[|$)/.exec(text)?.[1] ?? '';
    for (const m of section.matchAll(/^\s*[\w.-]+\s*=\s*["']([\w.]+):\w+["']/gm)) {
      const parts = m[1].split('.');
      for (const root of ['', 'src', dirOf(tp)]) {
        const base = join(root, parts.join('/'));
        const hit = allPaths.has(`${base}.py`) ? `${base}.py` : allPaths.has(`${base}/__init__.py`) ? `${base}/__init__.py` : undefined;
        if (hit) {
          add(hit, 'cli', 'pyproject console script', 10);
          break;
        }
      }
    }
  }

  for (const f of files.values()) {
    const base = f.path.slice(f.path.lastIndexOf('/') + 1);
    const depth = f.path.split('/').length - 1;
    if (f.signals.listen && depth <= 3) add(f.path, 'server', '.listen() call', 8);
    if (f.signals.mainGuard && !isTestPath(f.path)) add(f.path, /cli|command|manage/i.test(base) ? 'cli' : 'main', '__main__ guard', 6);
    if (f.signals.goMain) add(f.path, 'main', 'Go func main()', 9);
    if (f.signals.shebang && /(^|\/)(bin|scripts?)\//.test(f.path)) add(f.path, 'cli', 'shebang in bin/', 7);
    if (/(^|\/)src\/main\.rs$|(^|\/)src\/bin\/[^/]+\.rs$/.test(f.path)) add(f.path, 'main', 'Rust binary', 9);
    if (/(Application|Main)\.java$/.test(f.path)) add(f.path, 'main', 'Java main class', 7);
    if (CONVENTIONAL.test(base) && depth <= 2 && !isTestPath(f.path)) {
      const lib = /^index\./.test(base);
      add(f.path, /^cli\./.test(base) ? 'cli' : lib ? 'lib-index' : 'main', `conventional name ${base}`, lib ? 4 : 5);
    }
  }

  return [...found.values()]
    .filter((e) => e.score >= 4)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 8);
}

// --- Docs -----------------------------------------------------------------------

const MAX_DOCS = 40;
export const isDocPath = (p: string): boolean => /\.mdx?$/i.test(p) && (/^(readme|contributing|architecture|design|development|hacking)[\w.-]*\.mdx?$/i.test(p.slice(p.lastIndexOf('/') + 1)) || /(^|\/)(docs?|documentation)\//i.test(p));

const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// \x60 is a backtick; String.raw keeps the backslashes for RegExp.
const LEAD = String.raw`(^|[\s\x60'"(])`;
const LEAD_WITH_SLASH = String.raw`(^|[\s\x60'"(/])`;
const TRAIL = String.raw`($|[\s\x60'")\].,:;])`;

function mentioned(text: string, token: string, allowSlashBefore: boolean): boolean {
  return new RegExp((allowSlashBefore ? LEAD_WITH_SLASH : LEAD) + escapeRe(token) + TRAIL).test(text);
}

function mentionedAsDir(text: string, dir: string): boolean {
  return new RegExp(`${LEAD}${escapeRe(dir)}${String.raw`/(?![\w.-])`}`).test(text);
}

export function analyzeDocs(files: Map<string, ParsedFile>, texts: Map<string, string>): DocInfo[] {
  const codePaths = [...files.keys()].filter((p) => !isDocPath(p));
  const baseCount = new Map<string, number>();
  for (const p of codePaths) {
    const b = p.slice(p.lastIndexOf('/') + 1);
    baseCount.set(b, (baseCount.get(b) ?? 0) + 1);
  }
  const dirs = new Set<string>();
  for (const p of codePaths) for (let d = dirOf(p); d !== '' && !dirs.has(d); d = dirOf(d)) dirs.add(d);

  const docPaths = [...texts.keys()].filter(isDocPath).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, MAX_DOCS);
  const docs: DocInfo[] = [];
  for (const dp of docPaths) {
    const text = texts.get(dp) ?? '';
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim().slice(0, 120) ?? dp.slice(dp.lastIndexOf('/') + 1);
    const exact: DocInfo['describes'] = [];
    const likely: DocInfo['describes'] = [];
    for (const p of codePaths) {
      const b = p.slice(p.lastIndexOf('/') + 1);
      if (p.includes('/')) {
        if (p.length >= 5 && text.includes(p)) {
          exact.push({ path: p, isDir: false, confidence: 'exact' });
          continue;
        }
      } else if (b.length >= 3 && baseCount.get(b) === 1 && text.includes(`\`${b}\``)) {
        exact.push({ path: p, isDir: false, confidence: 'exact' }); // root-level file named in backticks
        continue;
      }
      if (b.length >= 8 && baseCount.get(b) === 1 && mentioned(text, b, true)) {
        likely.push({ path: p, isDir: false, confidence: 'likely' }); // unique basename only
      }
    }
    for (const d of dirs) {
      // A directory counts when written as `dir/` with no more path after it, or (multi-segment) as plain `dir`.
      if (mentionedAsDir(text, d) || (d.includes('/') && mentioned(text, d, false))) exact.push({ path: d, isDir: true, confidence: 'exact' });
    }
    docs.push({ path: dp, title, describes: [...exact, ...likely].slice(0, 80) });
  }
  return docs;
}

// --- Project facts -----------------------------------------------------------------

const STACK_HINTS: Record<string, string> = {
  express: 'Express', fastify: 'Fastify', koa: 'Koa', hono: 'Hono', next: 'Next.js', react: 'React', vue: 'Vue', svelte: 'Svelte',
  '@angular/core': 'Angular', '@nestjs/core': 'NestJS', vite: 'Vite', webpack: 'webpack', jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha',
  prisma: 'Prisma', typeorm: 'TypeORM', mongoose: 'Mongoose', sequelize: 'Sequelize', graphql: 'GraphQL', '@trpc/server': 'tRPC',
  zod: 'Zod', typescript: 'TypeScript', '@nitrostack/core': 'NitroStack', '@modelcontextprotocol/sdk': 'MCP SDK',
  flask: 'Flask', django: 'Django', fastapi: 'FastAPI', pytest: 'pytest', numpy: 'NumPy', pandas: 'pandas', sqlalchemy: 'SQLAlchemy',
  celery: 'Celery', pydantic: 'Pydantic', requests: 'requests', httpx: 'HTTPX', aiohttp: 'aiohttp', click: 'Click', typer: 'Typer',
  jinja2: 'Jinja2', werkzeug: 'Werkzeug', starlette: 'Starlette', uvicorn: 'Uvicorn', rich: 'Rich', attrs: 'attrs',
  'github.com/gin-gonic/gin': 'Gin', 'github.com/spf13/cobra': 'Cobra', tokio: 'Tokio', serde: 'Serde', clap: 'clap', axum: 'Axum', actix_web: 'Actix',
};

function depNamesFromPyproject(text: string): string[] {
  const names = new Set<string>();
  const arr = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? '';
  for (const m of arr.matchAll(/["']\s*([A-Za-z0-9_.-]+)/g)) names.add(m[1].toLowerCase());
  const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(text)?.[1] ?? '';
  for (const m of poetry.matchAll(/^([A-Za-z0-9_.-]+)\s*=/gm)) if (m[1].toLowerCase() !== 'python') names.add(m[1].toLowerCase());
  return [...names];
}

/** Tooling that is meaningful even as a devDependency; other hints count only as runtime dependencies. */
const DEV_OK = new Set(['typescript', 'vitest', 'jest', 'mocha', 'vite', 'webpack', 'pytest', 'prisma']);
const PROGRAMMING = new Set(['ts', 'js', 'py', 'go', 'rust', 'java', 'kotlin', 'ruby', 'php', 'c', 'cpp', 'csharp', 'swift', 'scala', 'shell', 'sql', 'css', 'html', 'vue', 'svelte', 'docker', 'asm', 'elixir', 'dart', 'lua', 'r', 'perl', 'zig', 'handlebars']);

export function detectProject(files: Map<string, ParsedFile>, texts: Map<string, string>, lockfiles: string[]): ProjectInfo {
  const languages: Record<string, number> = {};
  for (const f of files.values()) if (PROGRAMMING.has(f.lang)) languages[f.lang] = (languages[f.lang] ?? 0) + 1;

  const info: ProjectInfo = { languages, scripts: {}, stack: [], dependencies: [], workspaces: [] };
  const deps = new Set<string>();
  const devOnly = new Set<string>();

  const rootPkg = texts.get('package.json');
  if (rootPkg) {
    try {
      const pkg = JSON.parse(rootPkg) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      info.name = typeof pkg.name === 'string' ? pkg.name : undefined;
      info.description = typeof pkg.description === 'string' ? pkg.description.slice(0, 300) : undefined;
      info.license = typeof pkg.license === 'string' ? pkg.license : undefined;
      const wanted = ['start', 'dev', 'serve', 'build', 'test', 'lint', 'watch', 'prepare'];
      for (const k of wanted) if (typeof pkg.scripts?.[k] === 'string') info.scripts[k] = String(pkg.scripts[k]).slice(0, 200);
      for (const k of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]) deps.add(k);
      for (const k of Object.keys(pkg.devDependencies ?? {})) if (!deps.has(k)) devOnly.add(k);
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (Array.isArray(ws)) info.workspaces = ws.filter((w: unknown) => typeof w === 'string').slice(0, 20);
    } catch {
      // ignore broken package.json
    }
  }
  const py = texts.get('pyproject.toml');
  if (py) {
    info.name ??= /^\s*name\s*=\s*["']([^"']+)["']/m.exec(py)?.[1];
    info.description ??= /^\s*description\s*=\s*["']([^"']+)["']/m.exec(py)?.[1]?.slice(0, 300);
    for (const d of depNamesFromPyproject(py)) deps.add(d);
  }
  for (const [tp, text] of texts) {
    if (/(^|\/)requirements[\w.-]*\.txt$/.test(tp)) for (const m of text.matchAll(/^([A-Za-z0-9_.-]+)/gm)) deps.add(m[1].toLowerCase());
  }
  const gomod = texts.get('go.mod');
  if (gomod) {
    info.name ??= /^module\s+(\S+)/m.exec(gomod)?.[1];
    for (const m of gomod.matchAll(/^\s*([\w./-]+)\s+v[\d.]+/gm)) deps.add(m[1]);
  }
  const cargo = texts.get('Cargo.toml');
  if (cargo) {
    info.name ??= /^\s*name\s*=\s*["']([^"']+)["']/m.exec(cargo)?.[1];
    for (const m of (/\[dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(cargo)?.[1] ?? '').matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)) deps.add(m[1]);
  }

  info.dependencies = [...deps].sort().slice(0, 60);
  const stackNames = [...info.dependencies, ...[...devOnly].filter((d) => DEV_OK.has(d))];
  info.stack = [...new Set(stackNames.map((d) => STACK_HINTS[d]).filter(Boolean))].sort();
  const lock = new Set(lockfiles);
  info.packageManager = lock.has('pnpm-lock.yaml') ? 'pnpm' : lock.has('yarn.lock') ? 'yarn' : lock.has('bun.lockb') || lock.has('bun.lock') ? 'bun' : lock.has('package-lock.json') ? 'npm' : lock.has('poetry.lock') ? 'poetry' : lock.has('uv.lock') ? 'uv' : lock.has('Pipfile.lock') ? 'pipenv' : lock.has('Cargo.lock') ? 'cargo' : lock.has('go.sum') ? 'go modules' : undefined;

  const readmePath = [...texts.keys()].find((p) => /^readme(\.[a-z]+)?$/i.test(p));
  if (readmePath) {
    const text = texts.get(readmePath) ?? '';
    info.readmeTitle = /^#\s+(.+)$/m.exec(text)?.[1]?.trim().slice(0, 120);
    const para = text
      .replace(/<!--[\s\S]*?-->/g, '')
      .split(/\n{2,}/)
      .map((b) => b.trim())
      .find((b) => b && !/^(#|\[!\[|!\[|<|```|[-*|=]{3,})/.test(b) && b.length > 40);
    info.readmeExcerpt = para?.replace(/\s+/g, ' ').slice(0, 300);
  }
  return info;
}

// --- Entry point -------------------------------------------------------------------

export function analyze(input: AnalyzeInput): Analysis {
  const { files, commits, texts, lockfiles } = input;
  const g = importGraph(files);
  const pr: Record<string, number> = g.size > 0 ? pagerank(g, { getEdgeWeight: 'weight' }) : {};
  const maxPr = Math.max(0, ...Object.values(pr));
  const maxIn = Math.max(0, ...[...files.keys()].map((p) => g.inDegree(p)));

  const { testFor, testedBy } = associateTests(files);
  const hist = historyMetrics(files, commits);
  const entries = detectEntries(files, texts);
  const entryPaths = new Set(entries.map((e) => e.path));
  const docs = analyzeDocs(files, texts);
  const docMentions = new Map<string, number>();
  for (const d of docs) for (const x of d.describes) if (x.confidence === 'exact' && !x.isDir) docMentions.set(x.path, (docMentions.get(x.path) ?? 0) + 1);

  const out = new Map<string, FileAnalysis>();
  for (const p of files.keys()) {
    out.set(p, {
      fanIn: g.inDegree(p),
      fanOut: files.get(p)!.imports.length,
      centrality: isTestPath(p) || g.degree(p) === 0 ? 0 : Number((CENTRALITY_FANIN_WEIGHT * (maxIn > 0 ? g.inDegree(p) / maxIn : 0) + (1 - CENTRALITY_FANIN_WEIGHT) * (maxPr > 0 ? (pr[p] ?? 0) / maxPr : 0)).toFixed(3)),
      churn: hist.churn.get(p) ?? 0,
      lastChangedAt: hist.last.get(p),
      owners: hist.owners.get(p) ?? [],
      isEntry: entryPaths.has(p),
      isConfig: isConfigPath(p),
      isTest: isTestPath(p),
      testFor: testFor.get(p) ?? [],
      testedBy: testedBy.get(p) ?? [],
      docsMentions: docMentions.get(p) ?? 0,
      tags: tagsFor(p),
    });
  }

  return { files: out, entries, docs, project: detectProject(files, texts, lockfiles), coChange: hist.coChange, persons: hist.persons };
}
