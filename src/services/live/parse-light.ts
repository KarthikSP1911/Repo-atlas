import {
  cleanDoc,
  countLines,
  dirOf,
  findWorkspaces,
  join,
  langOf,
  probeFile,
  pyDocAndSymbols,
  pyImportsOf,
  resolveWorkspace,
  type ParsedFile,
  type ParseResult,
  type Workspace,
} from '../parse.common.js';

/**
 * The live build's parser: regexes instead of the TypeScript compiler, so it runs on the server
 * (pure JavaScript, no heavy dependencies). It finds the same things as the offline parser
 * (imports, exported names, a doc line, entry-point signals) but can be fooled by unusual code,
 * which is why live snapshots say "approximate" in their limits.
 */

const MAX_PARSE_BYTES = 400 * 1024;
const MAX_TSCONFIGS = 60;

/** Remove block comments and whole-line `//` comments so commented-out imports do not count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, '');
}

const RE_FROM = /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[\w*${},\s]*?\s+from\s+)?['"]([^'"\n]+)['"]/g;
const RE_REQUIRE = /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const RE_DYNAMIC = /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

export function jsSpecifiers(content: string): string[] {
  const text = stripComments(content);
  const specs: string[] = [];
  for (const re of [RE_FROM, RE_REQUIRE, RE_DYNAMIC]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

const RE_EXPORT_DECL = /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const RE_EXPORT_LIST = /^export\s*(?:type\s*)?\{([^}]*)\}/gm;
const RE_EXPORT_DEFAULT = /^export\s+default\b(?!\s+(?:async\s+)?(?:function|class)\s+[A-Za-z_$])/m;
const RE_TOP_DECL = /^(?:async\s+)?(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm;

export function jsSymbols(content: string): { exports: string[]; symbols: string[] } {
  const exports = new Set<string>();
  const symbols = new Set<string>();
  for (const m of content.matchAll(RE_EXPORT_DECL)) exports.add(m[1]);
  for (const m of content.matchAll(RE_EXPORT_LIST)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) exports.add(name);
    }
  }
  if (RE_EXPORT_DEFAULT.test(content)) exports.add('default');
  for (const m of content.matchAll(RE_TOP_DECL)) {
    const name = m[1] ?? m[2];
    if (name && !exports.has(name)) symbols.add(name);
  }
  return { exports: [...exports].slice(0, 25), symbols: [...symbols].slice(0, 25) };
}

function jsDoc(content: string): string | undefined {
  const m = /^\s*(?:#![^\n]*\n\s*)?(?:\/\*+([\s\S]*?)\*\/|((?:\/\/[^\n]*\n)+))/.exec(content);
  if (!m) return undefined;
  return cleanDoc(m[1] ?? m[2] ?? '');
}

// --- tsconfig paths -----------------------------------------------------------

interface PathConfig {
  dir: string;
  baseUrl: string | undefined;
  paths: [pattern: string, targets: string[]][];
}

/** tsconfig.json allows comments and trailing commas; strip both before JSON.parse. */
function parseJsonc(text: string): unknown {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1');
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
}

function indexPathConfigs(allPaths: Set<string>, contents: Map<string, string>): Map<string, PathConfig> {
  const out = new Map<string, PathConfig>();
  const cfgs = [...allPaths].filter((p) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(p)).sort().slice(0, MAX_TSCONFIGS);
  for (const cfg of cfgs) {
    const text = contents.get(cfg);
    if (text === undefined) continue;
    try {
      const json = parseJsonc(text) as { compilerOptions?: { baseUrl?: unknown; paths?: Record<string, unknown> } };
      const co = json?.compilerOptions;
      if (!co) continue;
      const paths: PathConfig['paths'] = [];
      for (const [k, v] of Object.entries(co.paths ?? {})) {
        if (Array.isArray(v)) paths.push([k, v.filter((x): x is string => typeof x === 'string')]);
      }
      const dir = dirOf(cfg);
      if (!out.has(dir) && (typeof co.baseUrl === 'string' || paths.length > 0)) {
        out.set(dir, { dir, baseUrl: typeof co.baseUrl === 'string' ? co.baseUrl : undefined, paths });
      }
    } catch {
      // a broken tsconfig only means no alias resolution for that folder
    }
  }
  return out;
}

function nearestConfig(file: string, configs: Map<string, PathConfig>): PathConfig | undefined {
  let d = dirOf(file);
  for (;;) {
    const hit = configs.get(d);
    if (hit) return hit;
    if (d === '') return undefined;
    d = dirOf(d);
  }
}

function resolveAlias(spec: string, from: string, configs: Map<string, PathConfig>, allPaths: Set<string>): string | undefined {
  const cfg = nearestConfig(from, configs);
  if (cfg) {
    const base = join(cfg.dir, cfg.baseUrl ?? '.');
    for (const [pattern, targets] of cfg.paths) {
      const star = pattern.indexOf('*');
      let rest: string | undefined;
      if (star === -1) rest = spec === pattern ? '' : undefined;
      else if (spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1))) rest = spec.slice(star, spec.length - (pattern.length - star - 1));
      if (rest === undefined) continue;
      for (const t of targets) {
        const hit = probeFile(join(base, t.replace('*', rest)), allPaths);
        if (hit) return hit;
      }
    }
    if (cfg.baseUrl !== undefined) {
      const hit = probeFile(join(base, spec), allPaths);
      if (hit) return hit;
    }
  }
  // Common alias convention without (or beyond) a tsconfig mapping: "@/x" or "~/x" means src/x.
  const m = /^[@~]\/(.+)$/.exec(spec);
  if (m) return probeFile(join('src', m[1]), allPaths) ?? probeFile(m[1], allPaths);
  return undefined;
}

// --- entry point --------------------------------------------------------------

/**
 * Parse files held in memory. `contents` has the text of every source file to parse and of the
 * package.json / tsconfig.json files used for resolution; `lines` has line counts for the files
 * whose text was not kept.
 */
export function parseContentsLight(allPaths: Set<string>, contents: Map<string, string>, lines: Map<string, number> = new Map()): ParseResult {
  const configs = indexPathConfigs(allPaths, contents);
  const workspaces: Workspace[] = findWorkspaces(allPaths, contents);
  const files = new Map<string, ParsedFile>();
  const stats = { jsTsFiles: 0, pyFiles: 0, importEdges: 0, parseErrors: 0 };

  for (const p of [...allPaths].sort()) {
    const lang = langOf(p);
    const content = contents.get(p);
    const parsed: ParsedFile = { path: p, lang, loc: content === undefined ? (lines.get(p) ?? 0) : countLines(content), imports: [], exports: [], symbols: [], signals: {} };
    files.set(p, parsed);
    if (content === undefined) continue;

    if (content.startsWith('#!')) parsed.signals.shebang = true;
    if (lang === 'go' && /^package main\b/m.test(content) && /^func main\(\)/m.test(content)) parsed.signals.goMain = true;

    try {
      if (lang === 'ts' || lang === 'js') {
        stats.jsTsFiles++;
        if (/\.listen\s*\(/.test(content)) parsed.signals.listen = true;
        if (content.length <= MAX_PARSE_BYTES) {
          Object.assign(parsed, jsSymbols(content));
          parsed.doc = jsDoc(content);
        }
        const counts = new Map<string, number>();
        for (const spec of jsSpecifiers(content)) {
          if (!spec || spec.startsWith('node:')) continue;
          let target: string | undefined;
          if (spec.startsWith('.')) target = probeFile(join(dirOf(p), spec), allPaths);
          else target = resolveAlias(spec, p, configs, allPaths) ?? resolveWorkspace(spec, workspaces, allPaths);
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
