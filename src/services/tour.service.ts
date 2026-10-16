import { z } from 'zod';
import type { EntryView, FileView, GraphIndex, PrView } from './graph.query.js';
import { ROLES, UNTRUSTED_NOTE, buildSubgraph, type Role, type Subgraph } from './tool.util.js';

/**
 * Staged, role-based tour over a snapshot (blueprint section 8). Pure functions over a
 * GraphIndex: no I/O, no decorators. Every fact comes from the snapshot; nothing is invented.
 * Text taken from the repo (README, commit subjects, PR titles, docstrings) is UNTRUSTED data.
 */

export const STAGE_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export interface StageDef {
  n: number;
  name: string;
  learn: string;
  question: string;
  roles: readonly Role[];
}

export const STAGES: readonly StageDef[] = [
  { n: 1, name: 'Orient', learn: 'What the project is for, what it is built with, and how to run it.', question: 'Which command starts the project?', roles: ['new_dev', 'reviewer', 'tester', 'quick_look'] },
  { n: 2, name: 'Layout', learn: 'What each top-level folder is for and where new code of each kind belongs.', question: 'Where would a new API route live?', roles: ['new_dev', 'quick_look'] },
  { n: 3, name: 'Entry points', learn: 'Where execution starts and which files it reaches first.', question: 'Which file receives requests first?', roles: ['new_dev', 'reviewer', 'tester', 'quick_look'] },
  { n: 4, name: 'Core modules', learn: 'The few files most of the code depends on, so changes there deserve extra care.', question: 'Which module do most others depend on?', roles: ['new_dev', 'reviewer'] },
  { n: 5, name: 'Data and config', learn: 'Where models, configuration, environment settings and external services live.', question: 'Where is configuration read?', roles: ['new_dev'] },
  { n: 6, name: 'Tests', learn: 'Which tests cover the core modules and which core modules have none.', question: 'Which tests cover the core module?', roles: ['new_dev', 'tester'] },
  { n: 7, name: 'Change patterns', learn: 'What typical past changes touch and which files move together.', question: 'Which files change together most often?', roles: ['new_dev', 'reviewer'] },
  { n: 8, name: 'People', learn: 'Who has been changing which parts of the code recently.', question: 'Who last changed the core module?', roles: ['new_dev', 'reviewer'] },
];

export function stagesForRole(role: Role): number[] {
  return STAGES.filter((s) => s.roles.includes(role)).map((s) => s.n);
}

export interface StageChoice {
  served: number;
  stagesForRole: number[];
  notice?: string;
}

/** The stage to serve for a role: the requested one, else the next applicable one, else the last. */
export function resolveStage(role: Role, requested: number): StageChoice {
  const list = stagesForRole(role);
  if (list.includes(requested)) return { served: requested, stagesForRole: list };
  const served = list.find((n) => n >= requested) ?? list[list.length - 1];
  const name = (n: number): string => STAGES[n - 1].name;
  return {
    served,
    stagesForRole: list,
    notice: `Stage ${requested} (${name(requested)}) is not part of the ${role} tour, so stage ${served} (${name(served)}) is served instead. The ${role} tour is stages ${list.join(', ')}.`,
  };
}

/** Input contract shared by the tool and its tests. */
export const TourInputSchema = z.object({
  snapshotId: z.string().min(1).describe('Snapshot id'),
  role: z.enum(ROLES),
  stage: z.number().int().min(1).max(8),
});

// --- Output types ------------------------------------------------------------------

export interface CheckQuestion {
  question: string;
  answer: string;
  evidence: string[];
  note: string;
}

export interface TourStop {
  role: Role;
  requestedStage: number;
  stage: number;
  name: string;
  learn: string;
  content: Record<string, unknown>;
  checkQuestion: CheckQuestion;
  progress: string;
  stagesForRole: number[];
  nextStage: number | null;
  bridge?: { message: string; nextTools: string[] };
  highlight: string[];
  subgraph: Subgraph;
  notice?: string;
  dataNote: string;
}

const CHECK_NOTE =
  'For the agent only: do not reveal this answer before the user has tried. Compare their reply to it, then confirm or gently correct, citing the evidence paths.';

interface Stage {
  content: Record<string, unknown>;
  highlight: string[];
  question: { answer: string; evidence: string[] };
}
interface Ctx {
  idx: GraphIndex;
  notices: string[];
}

// --- Small helpers -------------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const clip = (s: unknown, n = 200): string | undefined => (typeof s === 'string' && s.trim() ? s.replace(/\s+/g, ' ').trim().slice(0, n) : undefined);
const top = <T>(arr: T[], n: number): T[] => arr.slice(0, n);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
const topDir = (p: string): string => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '.');
const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

const ROLE_RULES: [string, RegExp][] = [
  ['test', /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/i],
  ['docs', /\.(mdx?|rst|txt)$|(^|\/)docs?(\/|$)/i],
  ['config', /(^|\/)(config|settings|\.env[^/]*|[^/]*\.config\.[a-z]+|tsconfig[^/]*\.json|package\.json|pyproject\.toml|go\.mod|cargo\.toml)(\.[a-z]+)?$/i],
  ['route', /(^|\/)(routes?|controllers?|handlers?|endpoints?|api)(\/|$)/i],
  ['model', /(^|\/)(models?|schemas?|entities|migrations?|db|database)(\/|$)/i],
  ['service', /(^|\/)services?(\/|$)/i],
  ['util', /(^|\/)(utils?|helpers?|lib|common)(\/|$)/i],
  ['ui', /(^|\/)(components?|views?|pages|ui|web)(\/|$)|\.(tsx|jsx|vue|svelte|css)$/i],
  ['script', /(^|\/)(scripts?|bin|tools)(\/|$)/i],
  ['infra', /(^|\/)(\.github|docker|infra|deploy|k8s|terraform)(\/|$)|(^|\/)dockerfile|\.ya?ml$/i],
];

/** Role tags for a file: the snapshot's tags when present, else a name-based guess. */
function rolesOf(f: FileView): string[] {
  const tags = new Set(f.meta.tags ?? []);
  if (f.meta.isTest) tags.add('test');
  if (f.meta.isConfig) tags.add('config');
  if (tags.size === 0) for (const [role, re] of ROLE_RULES) if (re.test(f.path)) tags.add(role);
  return [...tags];
}

const NON_CODE_LANGS = new Set(['markdown', 'json', 'env', 'other', 'yaml', 'yml', 'toml', 'text', 'docker', 'xml', 'html', 'css']);
const NON_PRODUCT_DIR = /(^|\/)(_?examples?|docs?|tests?|vendor|third_party|fixtures?|node_modules|e2e)(\/|$)/i;

function isSource(f: FileView): boolean {
  if (f.meta.lang && NON_CODE_LANGS.has(f.meta.lang)) return false;
  const roles = rolesOf(f);
  return !roles.some((r) => r === 'test' || r === 'docs' || r === 'config' || r === 'infra');
}

const hasImportGraph = (idx: GraphIndex): boolean => idx.snap.edges.some((e) => e.kind === 'imports');
const fanInOf = (idx: GraphIndex, f: FileView): number => f.meta.fanIn ?? idx.importedBy(f.path).length;
const fanOutOf = (idx: GraphIndex, f: FileView): number => f.meta.fanOut ?? idx.imports(f.path).length;

function byMetric(idx: GraphIndex): (a: FileView, b: FileView) => number {
  return (a, b) =>
    fanInOf(idx, b) - fanInOf(idx, a) ||
    (b.meta.centrality ?? 0) - (a.meta.centrality ?? 0) ||
    (b.meta.churn ?? 0) - (a.meta.churn ?? 0) ||
    a.path.localeCompare(b.path);
}

/** Top core modules by fan-in; falls back to churn and size when the snapshot has no import edges. */
function coreModules(idx: GraphIndex, n = 5): { files: FileView[]; graphBased: boolean } {
  const src = [...idx.files.values()].filter(isSource);
  if (hasImportGraph(idx)) {
    const ranked = src.filter((f) => fanInOf(idx, f) > 0).sort(byMetric(idx));
    if (ranked.length) return { files: top(ranked, n), graphBased: true };
  }
  const prod = src.filter((f) => !NON_PRODUCT_DIR.test(f.path));
  const ranked = (prod.length ? prod : src).sort((a, b) => (b.meta.churn ?? 0) - (a.meta.churn ?? 0) || (b.meta.loc ?? 0) - (a.meta.loc ?? 0) || a.path.localeCompare(b.path));
  return { files: top(ranked, n), graphBased: false };
}

/** Tests that cover a file: its `testedBy` list plus any test whose `testFor` names it; nearest folder first. */
function testsFor(idx: GraphIndex, p: string): string[] {
  const set = new Set(idx.files.get(p)?.meta.testedBy ?? []);
  for (const f of idx.files.values()) if (f.meta.testFor?.includes(p)) set.add(f.path);
  const shared = (t: string): number => {
    const a = dirOf(t).split('/');
    const b = dirOf(p).split('/');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  return [...set].filter((t) => idx.files.has(t)).sort((a, b) => shared(b) - shared(a) || a.localeCompare(b));
}

function resolveEntries(idx: GraphIndex): { entry: EntryView; file?: string }[] {
  return idx.entries.map((entry) => {
    let file: string | undefined = idx.files.has(entry.path) ? entry.path : undefined;
    if (!file) {
      const node = idx.snap.nodes.find((n) => n.id === `entry:${entry.path}`);
      const viaMeta = str(node?.meta.file);
      if (viaMeta && idx.files.has(viaMeta)) file = viaMeta;
    }
    return { entry, file };
  });
}

function importChain(idx: GraphIndex, start: string, maxDepth = 3, maxFiles = 6): { path: string; depth: number; importedBy: string; weight: number }[] {
  const out: { path: string; depth: number; importedBy: string; weight: number }[] = [];
  const seen = new Set([start]);
  let frontier = [start];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const from of frontier) {
      for (const l of idx.imports(from)) {
        if (seen.has(l.path) || !idx.files.has(l.path)) continue;
        if (out.length >= maxFiles) return out;
        seen.add(l.path);
        out.push({ path: l.path, depth, importedBy: from, weight: l.weight });
        next.push(l.path);
      }
    }
    frontier = next;
  }
  return out;
}

const ROLE_SENTENCE: Record<string, string> = {
  route: 'HTTP routes and request handlers',
  model: 'data models, schemas and database access',
  service: 'business logic and services',
  util: 'shared helpers and utilities',
  ui: 'user interface code',
  test: 'tests',
  config: 'configuration',
  docs: 'documentation',
  script: 'scripts and tooling',
  infra: 'build, CI and deployment setup',
};

const isBot = (label: string): boolean => /\[bot\]|(^|[-_ ])bot$|^dependabot|^renovate|^github-actions|^snyk/i.test(label);
const mostRecent = (prs: PrView[]): PrView[] => [...prs].sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? '') || b.number - a.number);

// --- Stages -----------------------------------------------------------------------------

function scriptCommand(pm: string | undefined, name: string): string {
  if (pm === 'npm') return name === 'start' || name === 'test' ? `npm ${name}` : `npm run ${name}`;
  if (pm === 'yarn') return `yarn ${name}`;
  if (pm === 'pnpm') return `pnpm ${name}`;
  if (pm === 'bun') return `bun run ${name}`;
  return `script "${name}"`;
}

function stage1({ idx, notices }: Ctx): Stage {
  const project = idx.project;
  const pm = str(project.packageManager);
  const readme = idx.docs.find((d) => /^readme(\.[a-z]+)?$/i.test(d.path));
  const langCounts: Record<string, number> = {};
  const declared = project.languages && typeof project.languages === 'object' ? (project.languages as Record<string, number>) : undefined;
  if (declared) Object.assign(langCounts, declared);
  else for (const f of idx.files.values()) if (f.meta.lang) langCounts[f.meta.lang] = (langCounts[f.meta.lang] ?? 0) + 1;
  const languages = top(Object.entries(langCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), 6).map(([lang, files]) => ({ lang, files }));

  const entries = resolveEntries(idx);
  const runSteps: { command: string; source: string; runs?: string; evidence: string }[] = [];
  for (const { entry, file } of entries) {
    if (entry.command) runSteps.push({ command: entry.command, source: 'entry point', evidence: file ?? entry.path });
  }
  const scripts = project.scripts && typeof project.scripts === 'object' ? (project.scripts as Record<string, unknown>) : {};
  const scriptNames = Object.keys(scripts);
  const order = ['start', 'dev', 'serve', 'build', 'test', 'lint'];
  const picked = [...order.filter((k) => scriptNames.includes(k)), ...scriptNames.filter((k) => !order.includes(k))];
  for (const name of top(picked, 6)) {
    runSteps.push({ command: scriptCommand(pm, name), source: `scripts.${name}`, runs: clip(scripts[name], 120), evidence: 'package.json' });
  }
  const startStep = runSteps.find((s) => s.source === 'entry point') ?? runSteps.find((s) => /^scripts\.(start|dev|serve)$/.test(s.source));
  if (runSteps.length === 0) notices.push('No run steps were found in the snapshot (no scripts or entry commands); say so rather than guessing.');

  const manifest = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml'].find((m) => idx.files.has(m));
  const highlight = [...entries.map((e) => e.file).filter((x): x is string => !!x).slice(0, 3), ...(manifest ? [manifest] : [])];
  const readmeFile = readme && idx.files.has(readme.path) ? readme.path : undefined;
  if (readmeFile && !highlight.includes(readmeFile)) highlight.push(readmeFile);

  const description = clip(project.description, 300) ?? clip(project.readmeExcerpt, 300);
  const content = {
    project: {
      name: str(project.name) ?? idx.repo,
      repo: idx.repo,
      description,
      readmeTitle: clip(project.readmeTitle, 120) ?? clip(readme?.title, 120),
      readmeExcerpt: clip(project.readmeExcerpt, 300),
      readmePath: readme?.path,
      license: str(project.license),
      primaryLanguage: str(project.primaryLanguage),
      defaultBranch: str(project.defaultBranch),
    },
    languages,
    stack: strArr(project.stack),
    packageManager: pm,
    workspaces: strArr(project.workspaces),
    runSteps,
    untrustedFields: ['project.description', 'project.readmeTitle', 'project.readmeExcerpt', 'runSteps[].runs'],
    summary: description
      ? `${idx.repo}: ${description}`
      : `${idx.repo}: no description in the snapshot${readme ? `; the README is titled "${clip(readme.title, 80)}" (untrusted text)` : ''}.`,
  };
  const answer = startStep
    ? `${startStep.command} (${startStep.source === 'entry point' ? `entry ${startStep.evidence}` : `from ${startStep.evidence} ${startStep.source}`})`
    : runSteps.length
      ? `No dedicated start command was found. Available scripts: ${runSteps.map((s) => s.command).join(', ')}. This looks like a library or tool, so it is built and tested rather than started.`
      : 'The snapshot has no start command or scripts; the README (untrusted) or the manifest would be the place to look.';
  return { content, highlight, question: { answer, evidence: startStep ? [startStep.evidence] : manifest ? [manifest] : [] } };
}

function stage2({ idx, notices }: Ctx): Stage {
  const groups = new Map<string, { files: number; roles: Record<string, number> }>();
  const routeDirs = new Map<string, string[]>();
  for (const f of idx.files.values()) {
    const key = topDir(f.path);
    const g = groups.get(key) ?? { files: 0, roles: {} };
    g.files++;
    const roles = rolesOf(f);
    for (const r of roles) g.roles[r] = (g.roles[r] ?? 0) + 1;
    groups.set(key, g);
    if (roles.includes('route') && !roles.includes('test') && !roles.includes('docs')) routeDirs.set(dirOf(f.path), [...(routeDirs.get(dirOf(f.path)) ?? []), f.path]);
  }
  const folders = top([...groups.entries()].sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0])), 12).map(([path, g]) => {
    const dominant = Object.entries(g.roles).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([role, count]) => ({ role, files: count }));
    const label = path === '.' ? 'files at the repo root' : `${path}/`;
    const roleLine = dominant.length ? `${label}: mostly ${dominant.map((d) => ROLE_SENTENCE[d.role] ?? d.role).join(', also ')}.` : `${label}: mixed source files with no clear role tag.`;
    return { path, files: g.files, dominantRoles: dominant, role: roleLine, evidence: `${plural(g.files, 'file')}` };
  });
  const bestRoute = [...routeDirs.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  const newRoute = bestRoute
    ? { dir: bestRoute[0], routeFiles: bestRoute[1].length, examples: top(bestRoute[1].sort(), 3), evidence: `${plural(bestRoute[1].length, 'route-tagged file')} in ${bestRoute[0]}` }
    : null;
  if (!newRoute) notices.push('No route or handler files were identified in this repo (it may be a library or CLI), so there is no obvious place for a new route.');
  if (folders.length === 0) notices.push('The snapshot has no files, so no layout can be shown.');
  const highlight = newRoute ? top(newRoute.examples, 3) : [];
  const answer = newRoute ? `${newRoute.dir}/ (${plural(newRoute.routeFiles, 'route file')}, e.g. ${newRoute.examples[0]})` : 'This repo has no route or handler folder; it looks like a library or CLI, so new behaviour goes with the module it extends (see core modules).';
  return { content: { folders, newRouteLocation: newRoute ?? 'No route-like files found.' }, highlight, question: { answer, evidence: newRoute ? newRoute.examples : [] } };
}

function barrels(idx: GraphIndex, graph: boolean): FileView[] {
  const re = /(^|\/)(index\.[jt]sx?|__init__\.py|mod\.rs|lib\.rs)$/i;
  const pool = [...idx.files.values()].filter((f) => isSource(f) && !NON_PRODUCT_DIR.test(f.path));
  const named = pool.filter((f) => re.test(f.path));
  const depth = (p: string): number => p.split('/').length;
  if (named.length) {
    const sorted = graph
      ? named.sort((a, b) => fanOutOf(idx, b) - fanOutOf(idx, a) || depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))
      : named.sort((a, b) => depth(a.path) - depth(b.path) || (b.meta.churn ?? 0) - (a.meta.churn ?? 0) || a.path.localeCompare(b.path));
    return top(sorted, 5);
  }
  const rootFiles = pool.filter((f) => !f.path.includes('/'));
  const rest = rootFiles.length ? rootFiles : pool;
  return top(rest.sort((a, b) => (b.meta.churn ?? 0) - (a.meta.churn ?? 0) || (b.meta.loc ?? 0) - (a.meta.loc ?? 0) || a.path.localeCompare(b.path)), 5);
}

function stage3({ idx, notices }: Ctx): Stage {
  const graph = hasImportGraph(idx);
  const entries = resolveEntries(idx);
  if (entries.length) {
    const items = top(entries, 5).map(({ entry, file }, i) => {
      const chain = file && graph && i < 3 ? importChain(idx, file) : [];
      return {
        path: file ?? entry.path,
        kind: entry.kind,
        reasons: entry.reasons.length ? entry.reasons : entry.command ? [`started with ${entry.command}`] : [],
        command: entry.command,
        score: entry.score,
        firstImportChain: chain,
        evidence: `entry kind ${entry.kind}${entry.reasons.length ? `: ${entry.reasons.join(', ')}` : ''}`,
      };
    });
    if (!graph) notices.push('This snapshot has no import edges (Tier 1), so the files an entry point loads cannot be traced; only the entry points themselves are shown.');
    const first = items[0];
    const highlight = [...new Set(items.flatMap((it, i) => [...(idx.files.has(it.path) ? [it.path] : []), ...(i < 2 ? it.firstImportChain.map((c) => c.path) : [])]))];
    return {
      content: { entryPoints: items, looksLikeLibrary: false },
      highlight: top(highlight, 12),
      question: { answer: `${first.path} (${first.kind}${first.reasons.length ? `: ${first.reasons[0]}` : ''})`, evidence: [first.path, ...first.reasons] },
    };
  }
  const libs = barrels(idx, graph);
  notices.push(
    graph
      ? 'No entry points were detected, so this repo looks like a library: code is reached through its public index or barrel files, shown below.'
      : 'No entry points were detected and this snapshot has no import edges (Tier 1), so this repo looks like a library; the files below are guessed from names, folder depth, churn and size, not from imports.',
  );
  const items = libs.map((f) => ({ path: f.path, fanOut: graph ? fanOutOf(idx, f) : undefined, churn: f.meta.churn ?? 0, loc: f.meta.loc ?? 0, evidence: graph ? `imports ${plural(fanOutOf(idx, f), 'file')}` : `churn ${f.meta.churn ?? 0}, ${f.meta.loc ?? 0} lines` }));
  return {
    content: { entryPoints: [], looksLikeLibrary: true, message: 'No runnable entry point was found; this repo looks like a library. These are its likely public entry files.', libraryEntryFiles: items },
    highlight: libs.map((f) => f.path),
    question: {
      answer: libs.length ? `No server entry point exists (library); callers start at ${libs[0].path}.` : 'No entry point or index file was found in the snapshot.',
      evidence: libs.slice(0, 1).map((f) => f.path),
    },
  };
}

function stage4({ idx, notices }: Ctx): Stage {
  const { files, graphBased } = coreModules(idx);
  if (!graphBased) notices.push('This snapshot has no usable import edges (Tier 1), so "core" is estimated from how often files change (churn) and their size, not from who imports them.');
  if (files.length === 0) notices.push('No source files were found, so no core modules can be named.');
  const items = files.map((f) => {
    const importers = idx.importedBy(f.path);
    const fanIn = fanInOf(idx, f);
    return {
      path: f.path,
      fanIn: graphBased ? fanIn : undefined,
      fanOut: graphBased ? fanOutOf(idx, f) : undefined,
      centrality: graphBased ? f.meta.centrality ?? 0 : undefined,
      churn: f.meta.churn ?? 0,
      loc: f.meta.loc ?? 0,
      roles: rolesOf(f),
      importedBy: top(importers, 5).map((l) => l.path),
      doc: clip(f.meta.doc, 140),
      evidence: graphBased ? `fanIn ${fanIn}, centrality ${fmtNum(f.meta.centrality ?? 0)}, imported by ${top(importers, 3).map((l) => l.path).join(', ') || 'n/a'}` : `churn ${f.meta.churn ?? 0}, ${f.meta.loc ?? 0} lines (no import graph)`,
    };
  });
  const first = items[0];
  return {
    content: { rankedBy: graphBased ? 'fan-in (how many files import it), then centrality' : 'churn and size (no import graph)', coreModules: items, untrustedFields: ['coreModules[].doc'] },
    highlight: items.map((i) => i.path),
    question: {
      answer: first ? `${first.path} (${first.evidence})` : 'No core module could be identified.',
      evidence: first ? [first.path, ...first.importedBy.slice(0, 3)] : [],
    },
  };
}

const SERVICE_HINTS: [RegExp, string][] = [
  [/^(pg|postgres|pgx|psycopg2?.*|asyncpg|sqlalchemy|mysql2?|mysqlclient|sqlite3?|mongoose|mongodb|pymongo|typeorm|sequelize|knex|prisma|@prisma\/client|gorm.*|drizzle-orm)$|\/(pgx|gorm|go-sql-driver|mongo-driver|lib\/pq)(\/|$)/i, 'database'],
  [/^(redis|ioredis|aioredis|memcached)$|go-redis/i, 'cache or queue'],
  [/^(aws-sdk|@aws-sdk\/.*|boto3|botocore|@google-cloud\/.*|azure-.*)$|aws-sdk-go/i, 'cloud service'],
  [/^(stripe|paypal.*|braintree)$/i, 'payments'],
  [/^(axios|requests|httpx|node-fetch|got|aiohttp|urllib3)$/i, 'http client'],
  [/^(openai|anthropic|@anthropic-ai\/sdk|langchain.*|cohere)$/i, 'ai service'],
  [/^(kafkajs|amqplib|pika|celery|bullmq|nats)$/i, 'message broker'],
  [/^(nodemailer|sendgrid.*|@sendgrid\/.*|mailgun.*)$/i, 'email'],
];

function stage5({ idx, notices }: Ctx): Stage {
  const files = [...idx.files.values()];
  const project = idx.project;
  const configFiles = files.filter((f) => rolesOf(f).includes('config') && !rolesOf(f).includes('test')).sort((a, b) => fanInOf(idx, b) - fanInOf(idx, a) || a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  const envFiles = configFiles.filter((f) => /(^|\/)\.env/.test(f.path)).map((f) => f.path);
  const configReaders = configFiles.filter((f) => fanInOf(idx, f) > 0);
  const models = files.filter((f) => rolesOf(f).includes('model') && !rolesOf(f).includes('test') && !NON_CODE_LANGS.has(f.meta.lang ?? '')).sort(byMetric(idx));
  const deps = [...new Set([...strArr(project.dependencies), ...strArr(project.stack)])];
  const services: { dependency: string; kind: string; evidence: string }[] = [];
  for (const d of deps) {
    const hit = SERVICE_HINTS.find(([re]) => re.test(d));
    if (hit) services.push({ dependency: d, kind: hit[1], evidence: 'listed in the project manifest' });
  }
  if (deps.length === 0) notices.push('The snapshot did not capture a dependency list, so external services cannot be listed.');
  if (configFiles.length === 0) notices.push('No configuration files were identified.');
  const item = (f: FileView) => ({ path: f.path, fanIn: fanInOf(idx, f), importedBy: top(idx.importedBy(f.path), 4).map((l) => l.path), evidence: `fanIn ${fanInOf(idx, f)}${f.meta.loc ? `, ${f.meta.loc} lines` : ''}` });
  const reader = configReaders[0] ?? configFiles.find((f) => !/(^|\/)(package\.json|tsconfig[^/]*|\.editorconfig|\.gitignore)$/.test(f.path)) ?? configFiles[0];
  return {
    content: {
      configFiles: top(configFiles, 8).map(item),
      envFiles,
      configReaders: top(configReaders, 5).map(item),
      modelFiles: top(models, 8).map(item),
      externalServices: top(services, 10),
      note: configReaders.length ? undefined : 'No config file is imported by other files in this snapshot, so where settings are read is unknown; check the entry points.',
    },
    highlight: [...top(configReaders, 3), ...top(models, 3)].map((f) => f.path),
    question: {
      answer: reader ? (fanInOf(idx, reader) > 0 ? `${reader.path} (imported by ${plural(fanInOf(idx, reader), 'file')}, e.g. ${idx.importedBy(reader.path)[0]?.path})` : `${reader.path} (the main config file; no importers recorded)`) : 'No configuration file was found in the snapshot.',
      evidence: reader ? [reader.path, ...top(idx.importedBy(reader.path), 2).map((l) => l.path)] : [],
    },
  };
}

function stage6({ idx, notices }: Ctx): Stage {
  const { files: core, graphBased } = coreModules(idx);
  if (!graphBased) notices.push('"Core" here is estimated from churn and size because the snapshot has no import edges (Tier 1); test coverage links come from naming and folder conventions.');
  const map = core.map((f) => {
    const tests = testsFor(idx, f.path);
    return { module: f.path, tests: top(tests, 5), testCount: tests.length, evidence: tests.length ? `${plural(tests.length, 'test file')} (${top(tests, 2).join(', ')})` : 'no test file linked in the snapshot' };
  });
  const untested = map.filter((m) => m.testCount === 0).map((m) => m.module);
  const testFiles = [...idx.files.values()].filter((f) => rolesOf(f).includes('test'));
  const langs = new Set([...idx.files.values()].map((f) => f.meta.lang));
  const names = testFiles.map((f) => f.path);
  const deps = [...strArr(idx.project.stack), ...strArr(idx.project.dependencies)].map((d) => d.toLowerCase());
  const hints: string[] = [];
  for (const [name, re] of [['Vitest', /^vitest$/], ['Jest', /^jest$|^@types\/jest$/], ['Mocha', /^mocha$/], ['pytest', /^pytest/], ['Playwright', /playwright/]] as [string, RegExp][]) if (deps.some((d) => re.test(d))) hints.push(name);
  if (!hints.length) {
    if (names.some((n) => /\.(spec|test)\.[jt]sx?$/.test(n))) hints.push('JS/TS tests named *.test / *.spec (framework not captured)');
    if (names.some((n) => /(^|\/)test_[^/]+\.py$|_test\.py$/.test(n))) hints.push('Python tests (likely pytest or unittest)');
    if (langs.has('go') && names.some((n) => n.endsWith('_test.go'))) hints.push('go test (standard library)');
  }
  if (testFiles.length === 0) notices.push('No test files were identified in this snapshot.');
  const first = map[0];
  const highlight = [...core.slice(0, 3).map((f) => f.path), ...(first?.tests.slice(0, 3) ?? [])];
  return {
    content: {
      coreModuleTests: map,
      coreModulesWithoutTests: untested,
      testFileCount: testFiles.length,
      frameworkHint: hints.length ? hints : ['not detected'],
      note: untested.length ? `${plural(untested.length, 'core module')} have no linked tests: a safe place for a first test-writing contribution.` : undefined,
    },
    highlight: [...new Set(highlight)],
    question: {
      answer: first ? (first.testCount ? `${first.tests.join(', ')} (cover ${first.module})` : `None: no test is linked to ${first.module}.`) : 'No core module could be identified.',
      evidence: first ? [first.module, ...first.tests.slice(0, 3)] : [],
    },
  };
}

function coChangePairs(idx: GraphIndex): { a: string; b: string; count: number; source: string }[] {
  const given = idx.coChange.filter((p) => idx.files.has(p.a) && idx.files.has(p.b));
  if (given.length) return given.map((p) => ({ ...p, source: 'commit history' }));
  const groups = idx.prs.length ? idx.prs.map((p) => p.files) : idx.commits.map((c) => c.files);
  const counts = new Map<string, number>();
  for (const g of groups) {
    const files = [...new Set(g)].filter((f) => idx.files.has(f)).sort().slice(0, 30);
    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) counts.set(`${files[i]}\u0000${files[j]}`, (counts.get(`${files[i]}\u0000${files[j]}`) ?? 0) + 1);
  }
  const source = idx.prs.length ? 'derived from merged PRs' : 'derived from commits';
  return [...counts.entries()].map(([k, count]) => ({ a: k.split('\u0000')[0], b: k.split('\u0000')[1], count, source })).sort((x, y) => y.count - x.count || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}

function stage7({ idx, notices }: Ctx): Stage {
  const pairs = top(coChangePairs(idx), 8).map((p) => ({ ...p, evidence: `changed together ${p.count} time${p.count === 1 ? '' : 's'} (${p.source})` }));
  const prs = mostRecent(idx.prs);
  const recent = top(prs, 5).map((p) => ({
    number: p.number,
    title: clip(p.title, 120),
    mergedAt: p.mergedAt,
    author: p.author ? idx.personLabel(p.author) : undefined,
    files: top(p.files, 6),
    fileCount: p.files.length,
    evidence: `PR #${p.number}${p.mergedAt ? ` merged ${p.mergedAt.slice(0, 10)}` : ''}, ${plural(p.files.length, 'file')}`,
  }));
  const folderCounts = new Map<string, number>();
  for (const p of top(prs, 20)) for (const d of new Set(p.files.map((f) => dirOf(f).split('/').slice(0, 2).join('/')))) folderCounts.set(d, (folderCounts.get(d) ?? 0) + 1);
  const commonFolders = top([...folderCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), 5).map(([folder, n]) => ({ folder, prs: n, evidence: `touched by ${plural(n, 'recent PR')}` }));
  if (pairs.length === 0) notices.push('No co-change pairs could be found (not enough history in the snapshot).');
  if (recent.length === 0) notices.push('The snapshot has no merged PRs, so typical change patterns are limited to the co-change pairs.');
  const first = pairs[0];
  return {
    content: { coChange: pairs, recentMergedPrs: recent, commonFolders, untrustedFields: ['recentMergedPrs[].title'] },
    highlight: [...new Set(top(pairs, 3).flatMap((p) => [p.a, p.b]))],
    question: { answer: first ? `${first.a} and ${first.b} (${plural(first.count, 'time')})` : 'No pair of files stands out in the available history.', evidence: first ? [first.a, first.b] : [] },
  };
}

function stage8({ idx, notices }: Ctx): Stage {
  const { files: core } = coreModules(idx);
  const coreOwners = core.map((f) => {
    const latest = idx.commitsTouching(f.path, 1)[0];
    const lastBy = latest?.author ? idx.personLabel(latest.author) : f.meta.owners?.[0] ? idx.personLabel(f.meta.owners[0]) : undefined;
    return {
      module: f.path,
      owners: top(f.meta.owners ?? [], 3).map((o) => idx.personLabel(o)),
      lastChangedBy: lastBy,
      lastChangedAt: latest?.date || f.meta.lastChangedAt,
      lastCommit: latest ? { sha7: latest.sha7, subject: clip(latest.subject, 100) } : undefined,
      evidence: latest ? `commit ${latest.sha7} on ${latest.date.slice(0, 10)}` : f.meta.lastChangedAt ? `last changed ${f.meta.lastChangedAt}` : 'no history recorded for this file',
    };
  });
  const groups = new Map<string, { files: number; owners: Map<string, number> }>();
  for (const f of idx.files.values()) {
    const key = topDir(f.path);
    const g = groups.get(key) ?? { files: 0, owners: new Map() };
    g.files++;
    for (const o of f.meta.owners ?? []) g.owners.set(o, (g.owners.get(o) ?? 0) + 1);
    groups.set(key, g);
  }
  const folders = top([...groups.entries()].sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0])), 6).map(([path, g]) => ({
    path,
    owners: top([...g.owners.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), 3).map(([o, n]) => ({ person: idx.personLabel(o), files: n })),
    evidence: plural(g.files, 'file'),
  }));
  const people = [...idx.persons.values()].filter((p) => !isBot(p.label) && !isBot(p.login ?? '')).sort((a, b) => b.commits - a.commits || a.label.localeCompare(b.label));
  const mostActive = top(people, 5).map((p) => ({ person: idx.personLabel(p.id), commits: p.commits, evidence: `${plural(p.commits, 'commit')} in the window` }));
  const lastChangedOverall = idx.commits[0]?.date || undefined;
  if (mostActive.length === 0) notices.push('The snapshot has no people data.');
  const first = coreOwners[0];
  return {
    content: { coreModuleOwners: coreOwners, folderOwners: folders, mostActive, lastChangedOverall, note: 'Names are display names or GitHub logins from commit history; use them to know who to ask, not as a promise of availability.' },
    highlight: core.slice(0, 5).map((f) => f.path),
    question: {
      answer: first ? (first.lastChangedBy ? `${first.lastChangedBy} (${first.module}, ${first.lastChangedAt ? first.lastChangedAt.slice(0, 10) : 'date unknown'})` : `Unknown: no history for ${first.module}.`) : 'No core module could be identified.',
      evidence: first ? [first.module, first.evidence] : [],
    },
  };
}

const STAGE_FNS: Record<number, (c: Ctx) => Stage> = { 1: stage1, 2: stage2, 3: stage3, 4: stage4, 5: stage5, 6: stage6, 7: stage7, 8: stage8 };

/** One tour stop for a role. The server never remembers state: the caller passes the stage every time. */
export function tourStop(idx: GraphIndex, role: Role, requestedStage: number): TourStop {
  const choice = resolveStage(role, requestedStage);
  const def = STAGES[choice.served - 1];
  const notices: string[] = choice.notice ? [choice.notice] : [];
  let stage: Stage;
  try {
    stage = STAGE_FNS[choice.served]({ idx, notices });
  } catch (e) {
    notices.push(`Stage ${choice.served} could not be fully computed from this snapshot (${e instanceof Error ? e.message.slice(0, 120) : 'unknown error'}); tell the user plainly and move on.`);
    stage = { content: {}, highlight: [], question: { answer: 'Not available for this snapshot.', evidence: [] } };
  }
  const list = choice.stagesForRole;
  const at = list.indexOf(choice.served);
  const last = at === list.length - 1;
  const highlight = [...new Set(stage.highlight)].filter((p) => idx.files.has(p));
  return {
    role,
    requestedStage,
    stage: choice.served,
    name: def.name,
    learn: def.learn,
    content: stage.content,
    checkQuestion: { question: def.question, answer: stage.question.answer, evidence: stage.question.evidence, note: CHECK_NOTE },
    progress: `${at + 1} of ${list.length}`,
    stagesForRole: list,
    nextStage: last ? null : list[at + 1],
    ...(last
      ? { bridge: { message: 'That is the end of the tour. Now let us find you something to work on: look at your history and match you to a good first issue.', nextTools: ['profile_contributor', 'find_candidate_issues'] } }
      : {}),
    highlight,
    subgraph: buildSubgraph(idx, highlight),
    ...(notices.length ? { notice: notices.join(' ') } : {}),
    dataNote: UNTRUSTED_NOTE,
  };
}
