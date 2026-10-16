import type { FileView, GraphIndex } from './graph.query.js';
import { testsCovering } from './rank.service.js';

/**
 * Entry points with their first import chain, trace_flow (reading order from an entry) and the
 * explain_file dossier. Pure functions over a GraphIndex; everything is derived from the
 * snapshot. `doc` strings, commit subjects, PR titles and doc titles are UNTRUSTED repo text.
 */

export const CHAIN_MAX_DEPTH = 3;
export const CHAIN_MAX_FILES = 6;
export const TRACE_DEFAULT_DEPTH = 4;
export const TRACE_MAX_DEPTH = 6;
export const TRACE_DEFAULT_FILES = 20;
export const TRACE_MAX_FILES = 40;
const DOC_CLIP = 240;
const TOP = 8;

const clip = (s: string | undefined, n = DOC_CLIP): string | undefined => {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
const centrality = (idx: GraphIndex, p: string): number => idx.files.get(p)?.meta.centrality ?? 0;
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

// --- Entry points ----------------------------------------------------------------

export interface EntryInfo {
  path: string;
  /** The id key the snapshot used for this entry (may differ from `path` in sloppy snapshots). */
  key: string;
  kind: string;
  reasons: string[];
  command?: string;
  score: number;
}

/** idx.entries with each entry resolved to a real file path (via the `starts` edge), plus files flagged isEntry. */
export function normalizedEntries(idx: GraphIndex): EntryInfo[] {
  const startsTo = new Map<string, string>();
  for (const e of idx.snap.edges) if (e.kind === 'starts') startsTo.set(e.from, e.to.slice('file:'.length));
  const byPath = new Map<string, EntryInfo>();
  for (const e of idx.entries) {
    let path = e.path;
    if (!idx.files.has(path)) {
      const via = startsTo.get(`entry:${e.path}`);
      if (via && idx.files.has(via)) path = via;
      else {
        const r = idx.resolvePath(e.path);
        if (!r.file) continue;
        path = r.file.path;
      }
    }
    const prev = byPath.get(path);
    if (prev) {
      prev.score = Math.max(prev.score, e.score);
      prev.reasons = [...new Set([...prev.reasons, ...e.reasons])];
      prev.command = prev.command ?? e.command;
    } else byPath.set(path, { path, key: e.path, kind: e.kind, reasons: [...e.reasons], command: e.command, score: e.score });
  }
  for (const f of idx.files.values()) {
    if (f.meta.isEntry && !byPath.has(f.path)) byPath.set(f.path, { path: f.path, key: f.path, kind: 'main', reasons: ['flagged as an entry point in file metadata'], score: 0 });
  }
  return [...byPath.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export interface ChainStep {
  path: string;
  depth: number;
  via: string;
  tags: string[];
  doc?: string;
}

function step(f: FileView, depth: number, via: string): ChainStep {
  return { path: f.path, depth, via, tags: f.meta.tags ?? [], ...(f.meta.doc ? { doc: clip(f.meta.doc) } : {}) };
}

/** Best unvisited import of `from`: heaviest weight, then most central, then path (idx.imports is already weight-sorted). */
function bestImport(idx: GraphIndex, from: string, seen: Set<string>): { path: string; weight: number } | undefined {
  return idx
    .imports(from)
    .filter((l) => idx.files.has(l.path) && !seen.has(l.path))
    .sort((a, b) => b.weight - a.weight || centrality(idx, b.path) - centrality(idx, a.path) || a.path.localeCompare(b.path))[0];
}

/** One linear chain starting at `start`: always the heaviest, then most central, unvisited import. Depth <= 3, <= 6 files. */
export function firstChain(idx: GraphIndex, start: string, maxDepth = CHAIN_MAX_DEPTH, maxFiles = CHAIN_MAX_FILES): ChainStep[] {
  const first = idx.files.get(start);
  if (!first) return [];
  const steps: ChainStep[] = [step(first, 0, 'starting file')];
  const seen = new Set([start]);
  let cur = start;
  for (let depth = 1; depth <= maxDepth && steps.length < maxFiles; depth++) {
    const next = bestImport(idx, cur, seen);
    if (!next) break;
    seen.add(next.path);
    steps.push(step(idx.files.get(next.path)!, depth, `imported by ${cur} (weight ${next.weight})`));
    cur = next.path;
  }
  return steps;
}

export interface EntryPointItem {
  path: string;
  kind: string;
  reasons: string[];
  command?: string;
  score: number;
  firstChain: ChainStep[];
}

export interface LibraryCandidate {
  path: string;
  fanOut: number;
  fanIn: number;
  why: string;
}

export interface EntryPointsResult {
  entryPoints: EntryPointItem[];
  notice?: string;
  likelyPublicFiles?: LibraryCandidate[];
}

const INDEX_NAME = /^(index\.[a-z]+|__init__\.py|mod\.rs|lib\.rs)$/i;

/** No declared entries: guess the public surface from barrel names and fan-out. */
export function libraryCandidates(idx: GraphIndex, max = TOP): LibraryCandidate[] {
  const code = [...idx.files.values()].filter((f) => !(f.meta.isTest || (f.meta.tags ?? []).includes('test')) && !f.meta.isConfig && !(f.meta.tags ?? []).includes('docs') && ['ts', 'js', 'py', 'go', 'c', 'cpp', 'java', 'kt', 'rs', 'rb'].includes(f.meta.lang ?? ''));
  const rows = code.map((f) => ({ f, named: INDEX_NAME.test(baseName(f.path)), fanOut: f.meta.fanOut ?? 0, fanIn: f.meta.fanIn ?? 0 }));
  let picks = rows.filter((r) => r.named || r.fanOut > 0);
  let fallback = false;
  if (picks.length === 0) {
    // Tier 1 (no import graph): the biggest top-level source files are the best guess.
    picks = rows.filter((r) => !r.f.path.includes('/'));
    fallback = true;
  }
  picks.sort((a, b) => Number(b.named) - Number(a.named) || b.fanOut - a.fanOut || (b.f.meta.loc ?? 0) - (a.f.meta.loc ?? 0) || a.f.path.localeCompare(b.f.path));
  return picks.slice(0, max).map((r) => ({
    path: r.f.path,
    fanOut: r.fanOut,
    fanIn: r.fanIn,
    why: fallback
      ? 'top-level source file (no import graph in this snapshot, so ranked by size)'
      : [r.named ? `barrel-style name "${baseName(r.f.path)}"` : '', r.fanOut ? `imports ${plural(r.fanOut, 'file')}` : ''].filter(Boolean).join('; '),
  }));
}

export function findEntryPoints(idx: GraphIndex): EntryPointsResult {
  const entries = normalizedEntries(idx);
  if (entries.length === 0) {
    const likely = libraryCandidates(idx);
    return {
      entryPoints: [],
      notice:
        'No runnable entry point (package.json bin/main, __main__ guard, main function) was found, so this looks like a library. ' +
        (likely.length ? 'The likely public entry or barrel files are listed in likelyPublicFiles (by name "index" and fan-out).' : 'No obvious barrel files were found either; use key_files to see the most important files.'),
      likelyPublicFiles: likely,
    };
  }
  return {
    entryPoints: entries.map((e) => ({ path: e.path, kind: e.kind, reasons: e.reasons, ...(e.command ? { command: e.command } : {}), score: e.score, firstChain: firstChain(idx, e.path) })),
    ...(idx.snap.tier === 1 ? { notice: 'Tier 1 snapshot: there is no import graph, so each firstChain contains only the entry file.' } : {}),
  };
}

// --- Path resolution -------------------------------------------------------------

/** A file path, loose path, or an entry's id/path. */
export function resolveFileOrEntry(idx: GraphIndex, input: string): { file?: FileView; suggestions: string[] } {
  const r = idx.resolvePath(input);
  if (r.file) return r;
  const key = input.trim().replace(/^entry:/, '');
  const entry = normalizedEntries(idx).find((e) => e.key === key || e.path === key);
  if (entry) return { file: idx.files.get(entry.path), suggestions: [] };
  const lower = baseName(key).toLowerCase();
  const fromEntries = normalizedEntries(idx).filter((e) => lower && e.path.toLowerCase().includes(lower)).map((e) => e.path);
  return { suggestions: [...new Set([...r.suggestions, ...fromEntries])].slice(0, 5) };
}

// --- trace_flow ------------------------------------------------------------------

export interface TraceStep {
  order: number;
  path: string;
  depth: number;
  importedBy: string | null;
  tags: string[];
  doc?: string;
  exports: string[];
  why: string;
}

export interface TraceResult {
  entry: string;
  isEntryPoint: boolean;
  depth: number;
  maxFiles: number;
  steps: TraceStep[];
  edgesUsed: { from: string; to: string; weight: number }[];
  truncated: boolean;
  truncatedBy: 'maxFiles' | 'depth' | null;
  truncatedNote?: string;
  notice?: string;
}

export function traceFlow(idx: GraphIndex, entryFile: FileView, opts: { depth?: number; maxFiles?: number } = {}): TraceResult {
  const maxDepth = Math.min(Math.max(opts.depth ?? TRACE_DEFAULT_DEPTH, 0), TRACE_MAX_DEPTH);
  const maxFiles = Math.min(Math.max(opts.maxFiles ?? TRACE_DEFAULT_FILES, 1), TRACE_MAX_FILES);
  const isEntryPoint = normalizedEntries(idx).some((e) => e.path === entryFile.path);

  const mk = (f: FileView, order: number, depth: number, importedBy: string | null, why: string): TraceStep => ({
    order,
    path: f.path,
    depth,
    importedBy,
    tags: f.meta.tags ?? [],
    ...(f.meta.doc ? { doc: clip(f.meta.doc) } : {}),
    exports: (f.meta.exports ?? []).slice(0, TOP),
    why,
  });
  const steps: TraceStep[] = [mk(entryFile, 1, 0, null, isEntryPoint ? 'starting point (declared entry point)' : 'starting point you asked for')];
  const edgesUsed: TraceResult['edgesUsed'] = [];
  const seen = new Set([entryFile.path]);
  let frontier = [entryFile.path];
  let truncatedBy: TraceResult['truncatedBy'] = null;

  for (let depth = 1; depth <= maxDepth + 1 && frontier.length && !truncatedBy; depth++) {
    // Best parent edge for every not-yet-seen child at this depth: heaviest weight, then earliest parent in reading order.
    const best = new Map<string, { parent: string; weight: number }>();
    for (const parent of frontier) {
      for (const l of idx.imports(parent)) {
        if (!idx.files.has(l.path) || seen.has(l.path)) continue;
        const cur = best.get(l.path);
        if (!cur || l.weight > cur.weight) best.set(l.path, { parent, weight: l.weight });
      }
    }
    if (best.size === 0) break;
    if (depth > maxDepth) {
      truncatedBy = 'depth';
      break;
    }
    const level = [...best.entries()].sort((a, b) => b[1].weight - a[1].weight || centrality(idx, b[0]) - centrality(idx, a[0]) || a[0].localeCompare(b[0]));
    const next: string[] = [];
    for (const [p, { parent, weight }] of level) {
      if (steps.length >= maxFiles) {
        truncatedBy = 'maxFiles';
        break;
      }
      seen.add(p);
      steps.push(mk(idx.files.get(p)!, steps.length + 1, depth, parent, `imported by ${parent} (weight ${weight})`));
      edgesUsed.push({ from: parent, to: p, weight });
      next.push(p);
    }
    frontier = next;
  }

  const truncated = truncatedBy !== null;
  const result: TraceResult = {
    entry: entryFile.path,
    isEntryPoint,
    depth: maxDepth,
    maxFiles,
    steps,
    edgesUsed,
    truncated,
    truncatedBy,
  };
  if (truncatedBy === 'maxFiles') result.truncatedNote = `Stopped at maxFiles=${maxFiles}; more files are reachable. Raise maxFiles (max ${TRACE_MAX_FILES}) or trace from a deeper file.`;
  if (truncatedBy === 'depth') result.truncatedNote = `Stopped at depth=${maxDepth}; deeper imports exist. Raise depth (max ${TRACE_MAX_DEPTH}) or trace from one of the listed files.`;
  if (idx.snap.tier === 1) result.notice = 'Tier 1 snapshot: there is no import graph for this repo, so only the entry file is returned. Use key_files and explain_file for orientation.';
  else if (steps.length === 1) result.notice = 'This file imports no other file in the snapshot (it may only import external packages, or its language has no import parsing), so there is nothing to follow.';
  return result;
}

// --- explain_file ----------------------------------------------------------------

const TAG_ROLE: Record<string, string> = {
  config: 'configuration',
  infra: 'build, CI or infrastructure',
  docs: 'documentation',
  ui: 'user interface',
  util: 'shared helper code',
  route: 'HTTP route or request handler',
  test: 'test',
  model: 'data model',
  script: 'script',
  service: 'service or business logic',
};

const PATH_ROLE: [RegExp, string][] = [
  [/(^|\/)(routes?|controllers?|handlers?|api)\//i, 'HTTP route or request handler'],
  [/(^|\/)services?\//i, 'service or business logic'],
  [/(^|\/)(db|database|models?|migrations?)\//i, 'database or data model code'],
  [/(^|\/)(utils?|lib|helpers?|common)\//i, 'shared helper code'],
  [/(^|\/)(tests?|__tests__|spec)\//i, 'test'],
  [/(^|\/)(scripts?|bin)\//i, 'script'],
  [/(^|\/)docs?\//i, 'documentation'],
];

export function roleOf(f: FileView): { role: string; signals: string[] } {
  const signals: string[] = [];
  const kinds: string[] = [];
  if (f.meta.isEntry) { kinds.push('entry point'); signals.push('flagged as an entry point'); }
  if (f.meta.isTest) { kinds.push('test'); signals.push('flagged as a test file'); }
  if (f.meta.isConfig) { kinds.push('configuration'); signals.push('flagged as configuration'); }
  for (const t of f.meta.tags ?? []) {
    const r = TAG_ROLE[t];
    if (r) { kinds.push(r); signals.push(`tag "${t}"`); }
  }
  if (kinds.length === 0) {
    for (const [re, r] of PATH_ROLE) {
      if (re.test(f.path)) { kinds.push(r); signals.push('folder name in path'); break; }
    }
  }
  if ((f.meta.fanIn ?? 0) >= 3) signals.push(`imported by ${f.meta.fanIn} files, so other code depends on it`);
  const uniq = [...new Set(kinds)];
  if (uniq.length === 0) uniq.push(`${f.meta.lang ?? 'source'} source file`);
  return { role: uniq.join(' / '), signals };
}

export interface Dossier {
  path: string;
  role: string;
  roleSignals: string[];
  lang?: string;
  doc?: string;
  exports: string[];
  symbols: string[];
  metrics: { loc: number | null; fanIn: number; fanOut: number; centrality: number; churn: number; lastChangedAt: string | null };
  imports: { path: string; weight: number }[];
  importsTotal: number;
  importedBy: { path: string; weight: number }[];
  importedByTotal: number;
  testedBy: string[];
  testFor: string[];
  owners: { id: string; name: string }[];
  recentCommits: { sha7: string; subject: string; date: string; author?: string }[];
  mergedPrs: { number: number; title: string; mergedAt?: string; author?: string }[];
  docsMentioning: { doc: string; title: string; confidence: 'exact' | 'likely'; via: string }[];
  changesWith: { path: string; count: number }[];
  evidence: string[];
  confidence: { level: 'high' | 'medium' | 'low'; reason: string };
}

export function explainFile(idx: GraphIndex, f: FileView): Dossier {
  const m = f.meta;
  const { role, signals } = roleOf(f);
  const imports = idx.imports(f.path);
  const importedBy = idx.importedBy(f.path);
  const commits = idx.commitsTouching(f.path, 5);
  const prs = idx.prsTouching(f.path, 5);

  const docs: Dossier['docsMentioning'] = [];
  for (const d of idx.docs) {
    for (const x of d.describes) {
      if (x.path === f.path) docs.push({ doc: d.path, title: clip(d.title, 120) ?? d.path, confidence: x.confidence, via: 'names this file' });
      else if (x.isDir && (x.path === '.' || f.path.startsWith(`${x.path}/`))) docs.push({ doc: d.path, title: clip(d.title, 120) ?? d.path, confidence: x.confidence, via: `describes folder ${x.path}` });
    }
  }
  docs.sort((a, b) => Number(a.via.startsWith('describes')) - Number(b.via.startsWith('describes')) || Number(a.confidence === 'likely') - Number(b.confidence === 'likely') || a.doc.localeCompare(b.doc));

  const changesWith = idx.coChange
    .filter((p) => p.a === f.path || p.b === f.path)
    .map((p) => ({ path: p.a === f.path ? p.b : p.a, count: p.count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, TOP);

  const testedBy = testsCovering(idx, f.path);
  const fanIn = m.fanIn ?? importedBy.length;
  const fanOut = m.fanOut ?? imports.length;
  const churn = m.churn ?? 0;
  const hasHistory = churn > 0 || commits.length > 0;
  const connected = fanIn + fanOut > 0;

  const evidence: string[] = [`Role: ${role}.`];
  if (connected) evidence.push(`Imported by ${plural(fanIn, 'file')} and imports ${plural(fanOut, 'file')}.`);
  else evidence.push('No import edges recorded for this file.');
  evidence.push(hasHistory ? `Changed ${plural(churn, 'time')} in the last commit window${m.lastChangedAt ? `, last on ${m.lastChangedAt}` : ''}.` : 'No history recorded for this file in the commit window.');
  if (testedBy.length > 0) evidence.push(`Covered by ${plural(testedBy.length, 'test file')}.`);
  if ((m.testFor?.length ?? 0) > 0) evidence.push(`Tests ${m.testFor!.join(', ')}.`);
  if (docs.length) evidence.push(`${plural(docs.length, 'doc')} mention${docs.length === 1 ? 's' : ''} it or its folder.`);
  if (changesWith.length) evidence.push(`Often changes together with ${changesWith[0].path} (${changesWith[0].count} commits).`);

  const lows: string[] = [];
  if (idx.snap.tier === 1) lows.push('Tier 1 snapshot has no import graph');
  if (!hasHistory) lows.push('no history for this file in the commit window');
  if (idx.snap.truncated) lows.push('the snapshot is truncated');
  let confidence: Dossier['confidence'];
  if (lows.length) confidence = { level: 'low', reason: `${lows.join('; ')}.` };
  else if (!connected) confidence = { level: 'medium', reason: 'Tier 2 with history, but the file has no import edges, so its role rests on name, tags and history.' };
  else confidence = { level: 'high', reason: 'Tier 2 snapshot, not truncated, with import edges and history for this file.' };

  return {
    path: f.path,
    role,
    roleSignals: signals,
    ...(m.lang ? { lang: m.lang } : {}),
    ...(m.doc ? { doc: clip(m.doc) } : {}),
    exports: m.exports ?? [],
    symbols: m.symbols ?? [],
    metrics: { loc: m.loc ?? null, fanIn, fanOut, centrality: m.centrality ?? 0, churn, lastChangedAt: m.lastChangedAt ?? null },
    imports: imports.slice(0, TOP),
    importsTotal: imports.length,
    importedBy: importedBy.slice(0, TOP),
    importedByTotal: importedBy.length,
    testedBy,
    testFor: m.testFor ?? [],
    owners: (m.owners ?? []).map((id) => ({ id, name: idx.personLabel(id) })),
    recentCommits: commits.map((c) => ({ sha7: c.sha7, subject: clip(c.subject, 160) ?? '', date: c.date, ...(c.author ? { author: idx.personLabel(c.author) } : {}) })),
    mergedPrs: prs.filter((p) => p.mergedAt).map((p) => ({ number: p.number, title: clip(p.title, 160) ?? '', mergedAt: p.mergedAt, ...(p.author ? { author: idx.personLabel(p.author) } : {}) })),
    docsMentioning: docs.slice(0, TOP),
    changesWith,
    evidence,
    confidence,
  };
}
