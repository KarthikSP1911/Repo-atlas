import type { GraphIndex } from './graph.query.js';
import type { SnapshotInfo } from './store.service.js';
import { liveEnabled } from './live/registry.js';

/**
 * Pure logic behind `build_graph` and `project_overview`. Everything is derived from the
 * snapshot; commands marked `inferred` are conventional for the detected tooling, not read from
 * a file in the repo. Text taken from the repo (description, README excerpt) is untrusted data.
 */

export interface FolderRole {
  path: string;
  files: number;
  /** Role tags seen in this folder, most common first (route, model, service, util, ui, test, config, docs, script, infra). */
  tags: string[];
  /** One plain-language line for the folder. */
  role: string;
  evidence: string;
}

export interface RunStep {
  step: 'install' | 'build' | 'run' | 'test' | 'lint';
  command: string;
  /** Where the command comes from, e.g. "package.json scripts.start". */
  source: string;
  /** True when the command is the usual one for the tooling rather than read from a file. */
  inferred: boolean;
}

const ROLE_TEXT: Record<string, string> = {
  route: 'HTTP routes, controllers or handlers',
  model: 'data models, schemas or database access',
  service: 'business logic and services',
  util: 'shared helpers and utilities',
  ui: 'user interface: components, pages or static assets',
  test: 'automated tests',
  config: 'configuration',
  docs: 'documentation and examples',
  script: 'scripts, binaries and command-line tools',
  infra: 'build, deploy and CI configuration',
};

const NAME_HINTS: [RegExp, string][] = [
  [/^(src|source|lib|app|pkg|internal|core)$/i, 'main source code'],
  [/^(tests?|__tests__|spec|e2e)$/i, 'automated tests'],
  [/^(docs?|documentation)$/i, 'documentation'],
  [/^(examples?|_?examples|samples?|demo)$/i, 'example code (not part of the product)'],
  [/^(scripts?|bin|tools|cmd)$/i, 'scripts and command-line entry points'],
  [/^\.github$/i, 'GitHub configuration: workflows, issue templates'],
  [/^(packages|apps|libs|modules|crates)$/i, 'monorepo packages'],
  [/^(\.?config|configs)$/i, 'configuration'],
  [/^(public|static|assets)$/i, 'static assets'],
];

export function folderRoles(idx: GraphIndex, max = 12): FolderRole[] {
  const tops = [...idx.dirs.values()].filter((d) => d.path !== '.' && !d.path.includes('/'));
  const rootFiles = [...idx.files.keys()].filter((p) => !p.includes('/')).length;
  const out: FolderRole[] = tops
    .map((d) => {
      const tags = Object.entries(d.tags).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
      const byName = NAME_HINTS.find(([re]) => re.test(d.path))?.[1];
      // Role from what the code does: tests, docs and config files would otherwise drown the real role.
      const roleTags = tags.filter((t) => !['test', 'docs', 'config'].includes(t));
      const strong = roleTags.filter((t) => d.tags[t] >= Math.max(2, d.files * 0.15)).slice(0, 2);
      const byTag = strong.map((t) => ROLE_TEXT[t]).filter(Boolean);
      const role = byName ?? (byTag.length ? `mostly ${byTag.join(' and ')}` : tags[0] === 'test' && roleTags.length === 0 ? 'automated tests' : 'source files');
      const tagEvidence = tags.slice(0, 3).map((t) => `${d.tags[t]} ${t}`).join(', ');
      return { path: d.path, files: d.files, tags: tags.slice(0, 4), role, evidence: `${d.files} files${tagEvidence ? ` (${tagEvidence})` : ''}` };
    })
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
    .slice(0, max);
  if (rootFiles > 0) out.push({ path: '.', files: rootFiles, tags: ['config', 'docs'], role: 'repo root: project config, README, licence', evidence: `${rootFiles} files at the root` });
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function runSteps(idx: GraphIndex): RunStep[] {
  const p = idx.project as { scripts?: Record<string, string>; packageManager?: string; stack?: string[]; languages?: Record<string, number> };
  const scripts = p.scripts ?? {};
  const pm = str(p.packageManager);
  const stack = p.stack ?? [];
  const langs = p.languages ?? {};
  const steps: RunStep[] = [];
  const has = (path: string): boolean => idx.files.has(path);
  const jsRun = (name: string): string => (pm === 'yarn' ? `yarn ${name}` : pm === 'pnpm' ? `pnpm ${name}` : pm === 'bun' ? `bun run ${name}` : name === 'test' || name === 'start' ? `npm ${name}` : `npm run ${name}`);

  if (has('package.json')) {
    steps.push({ step: 'install', command: pm === 'yarn' ? 'yarn install' : pm === 'pnpm' ? 'pnpm install' : pm === 'bun' ? 'bun install' : 'npm install', source: pm ? `${pm} lockfile found` : 'package.json present', inferred: true });
    for (const [key, step] of [['build', 'build'], ['start', 'run'], ['dev', 'run'], ['test', 'test'], ['lint', 'lint']] as const) {
      if (scripts[key]) steps.push({ step, command: jsRun(key), source: `package.json scripts.${key} (${scripts[key].slice(0, 80)})`, inferred: false });
    }
  } else if (has('pyproject.toml') || has('setup.py') || [...idx.files.keys()].some((f) => /(^|\/)requirements[\w.-]*\.txt$/.test(f))) {
    const req = [...idx.files.keys()].find((f) => /^requirements[\w.-]*\.txt$/.test(f));
    steps.push({ step: 'install', command: pm === 'uv' ? 'uv sync' : pm === 'poetry' ? 'poetry install' : req ? `pip install -r ${req}` : 'pip install -e .', source: pm ? `${pm} lockfile found` : req ?? 'pyproject.toml / setup.py', inferred: true });
    if (stack.includes('pytest') || [...idx.files.keys()].some((f) => /(^|\/)(conftest|test_\w+)\.py$/.test(f))) steps.push({ step: 'test', command: pm === 'uv' ? 'uv run pytest' : 'pytest', source: 'pytest files present', inferred: true });
  } else if (has('go.mod')) {
    steps.push({ step: 'build', command: 'go build ./...', source: 'go.mod present', inferred: true });
    if ((langs.go ?? 0) > 0) steps.push({ step: 'test', command: 'go test ./...', source: 'Go files present', inferred: true });
  } else if (has('Cargo.toml')) {
    steps.push({ step: 'build', command: 'cargo build', source: 'Cargo.toml present', inferred: true });
    steps.push({ step: 'test', command: 'cargo test', source: 'Cargo.toml present', inferred: true });
  }
  if (has('Makefile') && !steps.some((s) => s.step === 'build')) steps.push({ step: 'build', command: 'make', source: 'Makefile present', inferred: true });
  for (const e of idx.entries) {
    if (e.command && !steps.some((s) => s.command === e.command)) steps.push({ step: 'run', command: e.command, source: `entry point ${e.path} (${e.reasons[0] ?? 'detected'})`, inferred: false });
  }
  return steps;
}

export interface Overview {
  repo: string;
  name?: string;
  /** From package.json / pyproject / GitHub. Untrusted text. */
  description?: string;
  readmeTitle?: string;
  readmeExcerpt?: string;
  license?: string;
  primaryLanguage?: string;
  defaultBranch?: string;
  languages: Record<string, number>;
  stack: string[];
  packageManager?: string;
  workspaces: string[];
  runSteps: RunStep[];
  folders: FolderRole[];
  entryPoints: { path: string; kind: string; reasons: string[]; command?: string }[];
  counts: { files: number; dirs: number; commitsInGraph: number; mergedPrs: number; people: number; docs: number };
  evidence: string[];
}

export function overviewOf(idx: GraphIndex): Overview {
  const p = idx.project as Record<string, unknown>;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const folders = folderRoles(idx);
  const steps = runSteps(idx);
  const evidence = [
    `Description and stack come from the repo's own manifest files (${['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'].filter((f) => idx.files.has(f)).join(', ') || 'none found'}) and GitHub metadata at build time.`,
    `Folder roles are inferred from path names and file role tags across ${idx.files.size} files.`,
    `${steps.filter((s) => s.inferred).length} of ${steps.length} run steps are conventional for the detected tooling, not read from the repo.`,
  ];
  return {
    repo: idx.repo,
    name: str(p.name),
    description: str(p.description),
    readmeTitle: str(p.readmeTitle),
    readmeExcerpt: str(p.readmeExcerpt),
    license: str(p.license),
    primaryLanguage: str(p.primaryLanguage),
    defaultBranch: str(p.defaultBranch),
    languages: (p.languages as Record<string, number> | undefined) ?? {},
    stack: arr(p.stack),
    packageManager: str(p.packageManager),
    workspaces: arr(p.workspaces),
    runSteps: steps,
    folders,
    entryPoints: idx.entries.slice(0, 6).map((e) => ({ path: e.path, kind: e.kind, reasons: e.reasons, command: e.command })),
    counts: { files: idx.files.size, dirs: idx.dirs.size, commitsInGraph: idx.commits.length, mergedPrs: idx.prs.length, people: idx.persons.size, docs: idx.docs.length },
    evidence,
  };
}

// --- build_graph ----------------------------------------------------------------

export interface BuildGraphResult {
  status: 'ready' | 'unavailable';
  message: string;
  /** Whether the snapshot was precomputed offline or built just now from GitHub. */
  source?: 'precomputed' | 'built_on_demand';
  snapshotId?: string;
  repo?: string;
  sha?: string;
  asOf?: string;
  tier?: 1 | 2;
  truncated?: boolean;
  commitWindow?: number;
  stats?: { files: number; dirs: number; importEdges: number; commitsInGraph: number; mergedPrs: number; people: number; languages: Record<string, number> };
  available: { snapshotId: string; repo: string; tier: 1 | 2; builtAt: string }[];
  nextSteps: string[];
}

export function availableList(infos: SnapshotInfo[]): BuildGraphResult['available'] {
  return infos.filter((i) => i.file !== 'sample').concat(infos.filter((i) => i.file === 'sample')).map((i) => ({ snapshotId: i.id, repo: i.repo, tier: i.tier, builtAt: i.builtAt }));
}

export function readyResult(idx: GraphIndex, infos: SnapshotInfo[]): BuildGraphResult {
  const imports = idx.snap.edges.filter((e) => e.kind === 'imports').length;
  const langs = (idx.project.languages as Record<string, number> | undefined) ?? {};
  return {
    status: 'ready',
    message: `Snapshot ${idx.id} is loaded. Pass this snapshotId to every other RepoAtlas tool.`,
    source: idx.snap.source ? 'built_on_demand' : 'precomputed',
    snapshotId: idx.id,
    repo: idx.repo,
    sha: idx.snap.sha,
    asOf: idx.snap.builtAt,
    tier: idx.snap.tier,
    truncated: idx.snap.truncated,
    commitWindow: idx.snap.commitWindow,
    stats: { files: idx.files.size, dirs: idx.dirs.size, importEdges: imports, commitsInGraph: idx.commits.length, mergedPrs: idx.prs.length, people: idx.persons.size, languages: langs },
    available: availableList(infos),
    nextSteps: ['project_overview(snapshotId)', 'find_entry_points(snapshotId)', 'key_files(snapshotId, role)', 'tour_next(snapshotId, role, stage: 1)'],
  };
}

export function unavailableResult(reason: string, infos: SnapshotInfo[]): BuildGraphResult {
  return {
    status: 'unavailable',
    message: liveEnabled()
      ? `${reason} Pass a public GitHub repo as owner/repo or a github.com URL, or pick one of the precomputed repos in \`available\`.`
      : `${reason} This server only serves repos that were precomputed ahead of time (building new repos is switched off). Pick one from \`available\`.`,
    available: availableList(infos),
    nextSteps: infos.length ? ['build_graph(repo: <one of available>)'] : ['No snapshots are installed on this server.'],
  };
}
