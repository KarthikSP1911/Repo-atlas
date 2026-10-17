import * as path from 'node:path';

/**
 * Pure helpers shared by the offline parser (parse.service, ts-morph) and the live on-demand
 * parser (live/parse-light). No heavy imports: the deployed server loads this file.
 */

export interface ParsedImport {
  /** Repo-relative path of the imported file. */
  to: string;
  /** Number of import statements from this file to `to`. */
  weight: number;
}

export interface ParsedFile {
  path: string;
  lang: string;
  loc: number;
  imports: ParsedImport[];
  /** Exported names (JS/TS) or public top-level names (Python). */
  exports: string[];
  /** Non-exported top-level names. */
  symbols: string[];
  /** First meaningful doc comment or docstring, at most 200 chars. Untrusted text. */
  doc?: string;
  signals: { shebang?: boolean; listen?: boolean; mainGuard?: boolean; goMain?: boolean };
}

export interface ParseResult {
  files: Map<string, ParsedFile>;
  /** 2 when at least one JS/TS or Python file was parsed for imports, else 1. */
  tier: 1 | 2;
  stats: { jsTsFiles: number; pyFiles: number; importEdges: number; parseErrors: number };
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', py: 'py', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  swift: 'swift', scala: 'scala', md: 'markdown', mdx: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  sh: 'shell', bash: 'shell', zsh: 'shell', html: 'html', s: 'asm', asm: 'asm', hbs: 'handlebars', ex: 'elixir', exs: 'elixir', dart: 'dart', lua: 'lua', r: 'r', pl: 'perl', zig: 'zig', nix: 'nix', tf: 'terraform', proto: 'protobuf', graphql: 'graphql', ini: 'ini', css: 'css', scss: 'css', sql: 'sql', txt: 'text', rst: 'text', vue: 'vue', svelte: 'svelte',
};

export function langOf(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (base === 'Dockerfile') return 'docker';
  if (base === 'Makefile') return 'make';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return LANG_BY_EXT[ext] ?? 'other';
}

export const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];

export const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const join = (...parts: string[]): string => path.posix.normalize(parts.filter((x) => x !== '').join('/'));

export function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

export function cleanDoc(raw: string): string | undefined {
  const text = raw
    .replace(/^\s*\/\*+/, '')
    .replace(/\*+\/\s*$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(\*|\/\/+|#+)\s?/, '').trim())
    .filter((l) => l && !l.startsWith('@'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || /copyright|license|spdx|eslint-disable|prettier-ignore/i.test(text)) return undefined;
  return text.slice(0, 200);
}

export interface Workspace {
  name: string;
  dir: string;
  entryCandidates: string[];
}

export function findWorkspaces(allPaths: Set<string>, contents: Map<string, string>): Workspace[] {
  const out: Workspace[] = [];
  for (const p of allPaths) {
    if (!p.endsWith('package.json') || (p !== 'package.json' && !p.endsWith('/package.json'))) continue;
    const dir = dirOf(p);
    if (dir === '') continue;
    try {
      const pkg = JSON.parse(contents.get(p) ?? '{}') as Record<string, unknown>;
      if (typeof pkg.name !== 'string') continue;
      const entries: string[] = [];
      for (const key of ['source', 'main', 'module', 'types']) {
        const v = pkg[key];
        if (typeof v === 'string') entries.push(v.replace(/^\.\//, ''));
      }
      entries.push('src/index', 'index', 'lib/index');
      out.push({ name: pkg.name, dir, entryCandidates: entries });
    } catch {
      // ignore unparsable package.json
    }
  }
  return out;
}

/** Try `base` as written, with extensions, as a directory index, and with `.js` swapped for `.ts`. */
export function probeFile(base: string, allPaths: Set<string>): string | undefined {
  const noExt = base.replace(/\.(m|c)?jsx?$/, '');
  const tries = [base, ...TS_EXTS.map((e) => base + e), ...TS_EXTS.map((e) => `${base}/index${e}`), ...TS_EXTS.map((e) => noExt + e)];
  return tries.find((t) => allPaths.has(t));
}

export function resolveWorkspace(spec: string, workspaces: Workspace[], allPaths: Set<string>): string | undefined {
  for (const ws of workspaces) {
    if (spec !== ws.name && !spec.startsWith(`${ws.name}/`)) continue;
    if (spec === ws.name) {
      for (const cand of ws.entryCandidates) {
        const direct = probeFile(join(ws.dir, cand), allPaths);
        if (direct) return direct;
        const asSrc = probeFile(join(ws.dir, cand.replace(/^(dist|distribution|build|lib|out|esm|cjs)\//, 'src/')), allPaths);
        if (asSrc) return asSrc;
      }
    } else {
      const sub = spec.slice(ws.name.length + 1);
      return probeFile(join(ws.dir, 'src', sub), allPaths) ?? probeFile(join(ws.dir, sub), allPaths);
    }
  }
  return undefined;
}

// --- Python --------------------------------------------------------------

const PY_IMPORT = /^[ \t]*import[ \t]+([^\n#;]+)/gm;
const PY_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#;]+)/gm;

function pyRoots(filePath: string, allPaths: Set<string>): string[] {
  // Import root of the package this file lives in: first ancestor whose own dir has no __init__.py.
  let d = dirOf(filePath);
  while (d !== '' && allPaths.has(join(d, '__init__.py'))) d = dirOf(d);
  return [...new Set([d, '', 'src', 'lib'])];
}

function pyModuleFile(parts: string[], roots: string[], allPaths: Set<string>): string | undefined {
  if (parts.length === 0) return undefined;
  for (const root of roots) {
    const base = join(root, parts.join('/'));
    if (allPaths.has(`${base}.py`)) return `${base}.py`;
    if (allPaths.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
  }
  return undefined;
}

export function pyImportsOf(filePath: string, content: string, allPaths: Set<string>): ParsedImport[] {
  const counts = new Map<string, number>();
  const add = (target: string | undefined): void => {
    if (target && target !== filePath) counts.set(target, (counts.get(target) ?? 0) + 1);
  };
  const roots = pyRoots(filePath, allPaths);

  for (const m of content.matchAll(PY_IMPORT)) {
    for (const part of m[1].split(',')) {
      const mod = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[\w.]+$/.test(mod)) add(pyModuleFile(mod.split('.'), roots, allPaths));
    }
  }
  for (const m of content.matchAll(PY_FROM)) {
    const dots = m[1].length;
    const modParts = m[2].split('.').filter(Boolean);
    const names = m[3].replace(/[()]/g, ' ').split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter((n) => /^\w+$/.test(n));
    let modRoots = roots;
    let base = '';
    if (dots > 0) {
      base = dirOf(filePath);
      for (let i = 1; i < dots; i++) base = dirOf(base);
      modRoots = [base];
    }
    // Names that are themselves submodules (`from pkg import sub`).
    const subFiles = names.map((n) => pyModuleFile([...modParts, n], modRoots, allPaths));
    for (const f of subFiles) add(f);
    // The module itself. A package __init__ is only a dependency when some imported name is not a
    // submodule (otherwise every `from . import x` would link to __init__.py).
    const modFile = modParts.length
      ? pyModuleFile(modParts, modRoots, allPaths)
      : dots > 0 && allPaths.has(join(base, '__init__.py'))
        ? join(base, '__init__.py')
        : undefined;
    const allSubmodules = names.length > 0 && subFiles.every(Boolean);
    if (modFile && !(modFile.endsWith('/__init__.py') && allSubmodules)) add(modFile);
  }
  return [...counts.entries()].map(([to, weight]) => ({ to, weight })).sort((a, b) => a.to.localeCompare(b.to));
}

export function pyDocAndSymbols(content: string): { doc?: string; exports: string[]; symbols: string[] } {
  const exports: string[] = [];
  const symbols: string[] = [];
  for (const m of content.matchAll(/^(?:async[ \t]+)?(?:def|class)[ \t]+(\w+)/gm)) {
    (m[1].startsWith('_') ? symbols : exports).push(m[1]);
  }
  const d = /^\s*(?:#[^\n]*\n|\s)*?(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(content);
  const doc = d ? cleanDoc(d[1].split('\n').filter((l) => l.trim())[0] ?? '') : undefined;
  return { doc, exports: exports.slice(0, 25), symbols: symbols.slice(0, 25) };
}

