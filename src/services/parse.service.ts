import { Node, Project, SyntaxKind, ts } from 'ts-morph';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { IngestFile } from './ingest.service.js';

/**
 * OFFLINE ONLY. Extracts imports, exported and top-level symbol names, a one-line doc and a few
 * content signals (shebang, `.listen(`, `__main__` guard, Go `main`) from source files.
 * JS/TS use ts-morph (syntax only, no type checking); Python uses regex hints. Every other
 * language gets lines of code and a language tag (Tier 1).
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
  sh: 'shell', bash: 'shell', html: 'html', css: 'css', scss: 'css', sql: 'sql', txt: 'text', rst: 'text', vue: 'vue', svelte: 'svelte',
};

export function langOf(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (base === 'Dockerfile') return 'docker';
  if (base === 'Makefile') return 'make';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return LANG_BY_EXT[ext] ?? (ext || 'other');
}

const MAX_PARSE_BYTES = 400 * 1024;
const VROOT = '/repo';
const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];

export const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const join = (...parts: string[]): string => path.posix.normalize(parts.filter((x) => x !== '').join('/'));

function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

function cleanDoc(raw: string): string | undefined {
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

// --- JS / TS -------------------------------------------------------------

function makeHost(allPaths: Set<string>, contents: Map<string, string>, dirs: Set<string>): ts.ModuleResolutionHost {
  const rel = (p: string): string | null => (p.startsWith(`${VROOT}/`) ? p.slice(VROOT.length + 1) : null);
  return {
    fileExists: (p) => {
      const r = rel(p);
      return r !== null && allPaths.has(r);
    },
    readFile: (p) => {
      const r = rel(p);
      return r === null ? undefined : contents.get(r);
    },
    directoryExists: (p) => p === VROOT || dirs.has(rel(p) ?? '\0'),
    realpath: (p) => p,
    getCurrentDirectory: () => VROOT,
  };
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  resolveJsonModule: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
};

interface TsConfigIndex {
  optionsFor(filePath: string): ts.CompilerOptions;
}

function indexTsConfigs(allPaths: Set<string>, contents: Map<string, string>): TsConfigIndex {
  const cfgPaths = [...allPaths].filter((p) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(p)).slice(0, 60);
  const parseHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: () => [],
    fileExists: (p) => p.startsWith(`${VROOT}/`) && allPaths.has(p.slice(VROOT.length + 1)),
    readFile: (p) => (p.startsWith(`${VROOT}/`) ? contents.get(p.slice(VROOT.length + 1)) : undefined),
  };
  const byDir = new Map<string, ts.CompilerOptions>();
  for (const cfg of cfgPaths) {
    const text = contents.get(cfg);
    if (text === undefined) continue;
    try {
      const json = ts.parseConfigFileTextToJson(`${VROOT}/${cfg}`, text);
      if (json.error || !json.config) continue;
      const parsed = ts.parseJsonConfigFileContent(json.config, parseHost, `${VROOT}/${dirOf(cfg)}`.replace(/\/$/, ''), undefined, `${VROOT}/${cfg}`);
      const opts: ts.CompilerOptions = { ...DEFAULT_OPTIONS, ...parsed.options, allowJs: true, resolveJsonModule: true };
      if (!parsed.options.moduleResolution || parsed.options.moduleResolution === ts.ModuleResolutionKind.Classic) {
        opts.moduleResolution = ts.ModuleResolutionKind.Bundler;
        opts.module = ts.ModuleKind.ESNext;
      }
      if (!byDir.has(dirOf(cfg))) byDir.set(dirOf(cfg), opts); // tsconfig.json wins over jsconfig.json (sorted later)
    } catch {
      // A broken tsconfig just means default resolution for that folder.
    }
  }
  return {
    optionsFor(filePath: string): ts.CompilerOptions {
      let d = dirOf(filePath);
      for (;;) {
        const hit = byDir.get(d);
        if (hit) return hit;
        if (d === '') return DEFAULT_OPTIONS;
        d = dirOf(d);
      }
    },
  };
}

interface Workspace {
  name: string;
  dir: string;
  entryCandidates: string[];
}

function findWorkspaces(allPaths: Set<string>, contents: Map<string, string>): Workspace[] {
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

function resolveWorkspace(spec: string, workspaces: Workspace[], allPaths: Set<string>): string | undefined {
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

interface ExtractedTs {
  specs: string[];
  exports: string[];
  symbols: string[];
  doc?: string;
}

function extractTs(project: Project, filePath: string, content: string): ExtractedTs {
  const sf = project.createSourceFile(`${VROOT}/${filePath}`, content, { overwrite: true });
  try {
    const specs: string[] = [];
    for (const d of sf.getImportDeclarations()) specs.push(d.getModuleSpecifierValue());
    for (const d of sf.getExportDeclarations()) {
      const s = d.getModuleSpecifierValue();
      if (s) specs.push(s);
    }
    sf.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const arg = node.getArguments()[0];
      if (!arg || !(Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) return;
      const expr = node.getExpression();
      if (expr.getKind() === SyntaxKind.ImportKeyword || (Node.isIdentifier(expr) && expr.getText() === 'require')) {
        specs.push(arg.getLiteralText());
      }
    });

    const exports: string[] = [];
    const symbols: string[] = [];
    const put = (exported: boolean, name: string | undefined): void => {
      if (name) (exported ? exports : symbols).push(name);
    };
    for (const st of sf.getStatements()) {
      if (Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) {
        put(st.isExported(), st.isDefaultExport() && !st.getName() ? 'default' : st.getName());
      } else if (Node.isInterfaceDeclaration(st) || Node.isTypeAliasDeclaration(st) || Node.isEnumDeclaration(st)) {
        put(st.isExported(), st.getName());
      } else if (Node.isVariableStatement(st)) {
        for (const decl of st.getDeclarations()) {
          const name = decl.getName();
          if (!/[{[]/.test(name)) put(st.isExported(), name);
        }
      } else if (Node.isExportDeclaration(st)) {
        for (const ne of st.getNamedExports()) exports.push(ne.getAliasNode()?.getText() ?? ne.getName());
      } else if (Node.isExportAssignment(st)) {
        exports.push('default');
      }
    }

    let doc: string | undefined;
    const first = sf.getStatements()[0];
    for (const r of first?.getLeadingCommentRanges() ?? []) {
      doc = cleanDoc(r.getText());
      if (doc) break;
    }
    if (!doc) {
      for (const st of sf.getStatements()) {
        if (Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) {
          const d = st.getJsDocs()[0]?.getDescription();
          if (d && (doc = cleanDoc(d))) break;
        }
      }
    }
    return { specs, exports: [...new Set(exports)].slice(0, 25), symbols: [...new Set(symbols)].slice(0, 25), doc };
  } finally {
    project.removeSourceFile(sf);
  }
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

function pyDocAndSymbols(content: string): { doc?: string; exports: string[]; symbols: string[] } {
  const exports: string[] = [];
  const symbols: string[] = [];
  for (const m of content.matchAll(/^(?:async[ \t]+)?(?:def|class)[ \t]+(\w+)/gm)) {
    (m[1].startsWith('_') ? symbols : exports).push(m[1]);
  }
  const d = /^\s*(?:#[^\n]*\n|\s)*?(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(content);
  const doc = d ? cleanDoc(d[1].split('\n').filter((l) => l.trim())[0] ?? '') : undefined;
  return { doc, exports: exports.slice(0, 25), symbols: symbols.slice(0, 25) };
}

// --- Entry points ----------------------------------------------------------

/**
 * Parse files held in memory. `contents` must include every source file to parse plus any
 * package.json / tsconfig.json / jsconfig.json needed for resolution; `allPaths` is every kept
 * repo path (used to decide what an import resolves to).
 */
export function parseContents(allPaths: Set<string>, contents: Map<string, string>): ParseResult {
  const dirs = new Set<string>();
  for (const p of allPaths) for (let d = dirOf(p); d !== '' && !dirs.has(d); d = dirOf(d)) dirs.add(d);

  const host = makeHost(allPaths, contents, dirs);
  const cfgs = indexTsConfigs(allPaths, contents);
  const workspaces = findWorkspaces(allPaths, contents);
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noResolve: true, jsx: ts.JsxEmit.Preserve },
  });

  const files = new Map<string, ParsedFile>();
  const stats = { jsTsFiles: 0, pyFiles: 0, importEdges: 0, parseErrors: 0 };

  for (const p of [...allPaths].sort()) {
    const lang = langOf(p);
    const content = contents.get(p);
    const parsed: ParsedFile = { path: p, lang, loc: content === undefined ? 0 : countLines(content), imports: [], exports: [], symbols: [], signals: {} };
    files.set(p, parsed);
    if (content === undefined) continue;

    if (content.startsWith('#!')) parsed.signals.shebang = true;
    if (lang === 'go' && /^package main\b/m.test(content) && /^func main\(\)/m.test(content)) parsed.signals.goMain = true;

    try {
      if (lang === 'ts' || lang === 'js') {
        stats.jsTsFiles++;
        if (/\.listen\s*\(/.test(content)) parsed.signals.listen = true;
        let specs: string[];
        if (content.length > MAX_PARSE_BYTES) {
          specs = ts.preProcessFile(content, true, true).importedFiles.map((f) => f.fileName);
        } else {
          const ex = extractTs(project, p, content);
          specs = ex.specs;
          parsed.exports = ex.exports;
          parsed.symbols = ex.symbols;
          parsed.doc = ex.doc;
        }
        const options = cfgs.optionsFor(p);
        const counts = new Map<string, number>();
        for (const spec of specs) {
          if (!spec || spec.startsWith('node:')) continue;
          const res = ts.resolveModuleName(spec, `${VROOT}/${p}`, options, host);
          let target: string | undefined;
          const resolved = res.resolvedModule;
          if (resolved && !resolved.isExternalLibraryImport && resolved.resolvedFileName.startsWith(`${VROOT}/`)) {
            target = resolved.resolvedFileName.slice(VROOT.length + 1);
          } else if (!spec.startsWith('.')) {
            target = resolveWorkspace(spec, workspaces, allPaths);
          }
          if (target && target !== p && allPaths.has(target)) counts.set(target, (counts.get(target) ?? 0) + 1);
        }
        parsed.imports = [...counts.entries()].map(([to, weight]) => ({ to, weight })).sort((a, b) => a.to.localeCompare(b.to));
      } else if (lang === 'py') {
        stats.pyFiles++;
        if (/^if[ \t]+__name__[ \t]*==[ \t]*['"]__main__['"]/m.test(content)) parsed.signals.mainGuard = true;
        parsed.imports = pyImportsOf(p, content, allPaths);
        Object.assign(parsed, pyDocAndSymbols(content));
      }
    } catch {
      stats.parseErrors++;
    }
    stats.importEdges += parsed.imports.length;
  }

  return { files, tier: stats.jsTsFiles + stats.pyFiles > 0 ? 2 : 1, stats };
}

const NEEDS_CONTENT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go)$|(^|\/)(package|tsconfig|jsconfig)\.json$/;

/** Read the kept files from a checkout and parse them. Non-code files only get a line count. */
export async function parseFiles(dir: string, files: IngestFile[]): Promise<ParseResult> {
  const allPaths = new Set(files.map((f) => f.path));
  const contents = new Map<string, string>();
  const locOnly = new Map<string, number>();
  for (const f of files) {
    try {
      const text = await fs.readFile(path.join(dir, f.path), 'utf8');
      if (text.includes('\0')) continue; // binary that slipped through
      if (NEEDS_CONTENT.test(f.path)) contents.set(f.path, text);
      else locOnly.set(f.path, countLines(text));
    } catch {
      // unreadable file: leave it in the tree with loc 0
    }
  }
  const result = parseContents(allPaths, contents);
  for (const [p, loc] of locOnly) result.files.get(p)!.loc = loc;
  return result;
}
