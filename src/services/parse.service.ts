import { Node, Project, SyntaxKind, ts } from 'ts-morph';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { IngestFile } from './ingest.common.js';
import {
  cleanDoc,
  countLines,
  dirOf,
  findWorkspaces,
  join,
  langOf,
  pyDocAndSymbols,
  pyImportsOf,
  resolveWorkspace,
  type ParsedFile,
  type ParseResult,
} from './parse.common.js';

export * from './parse.common.js';

/**
 * OFFLINE ONLY. Extracts imports, exported and top-level symbol names, a one-line doc and a few
 * content signals (shebang, `.listen(`, `__main__` guard, Go `main`) from source files.
 * JS/TS use ts-morph (syntax only, no type checking); Python uses regex hints. Every other
 * language gets lines of code and a language tag (Tier 1).
 */

const MAX_PARSE_BYTES = 400 * 1024;
const VROOT = '/repo';
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
