import { KEY_FILES } from '../config/weights.js';
import type { GraphIndex, FileView } from './graph.query.js';
import type { Role } from './tool.util.js';

/**
 * key_files scoring. Pure functions over a GraphIndex: every number comes from the snapshot's
 * file metadata (entry flag, fan-in, config flag, churn, docs mentions, tests) and is returned
 * next to the score so the agent can show its work.
 *
 *   score = 3*entry + 2*fanInHat + 1.5*config + churnW*churnHat + 1*docsMentionsHat + 0.5*tests
 *           (+ 1.0 * testBearing for role=tester)
 *
 * `hat` values are the metric divided by the maximum over the candidate files (0 when the max is 0).
 */

export const BASE_WEIGHTS = { entry: KEY_FILES.entry, fanIn: KEY_FILES.fanIn, config: KEY_FILES.config, churn: KEY_FILES.churn, docsMentions: KEY_FILES.docsMentions, tests: KEY_FILES.tests, testBonus: 0 } as const;
export type Weights = { -readonly [K in keyof typeof BASE_WEIGHTS]: number };

export const TIER_MUST_SHARE = KEY_FILES.mustReadShare;
export const TIER_NEXT_SHARE = KEY_FILES.readNextShare;
export const QUICK_LOOK_CAP = 5;
export const DEFAULT_LIMIT = 15;

export type RankTier = 'Must read' | 'Read next' | 'Skip for now';

export interface RankComponents {
  entry: 0 | 1;
  fanIn: number;
  fanInHat: number;
  config: 0 | 1;
  churn: number;
  churnHat: number;
  docsMentions: number;
  docsMentionsHat: number;
  tests: 0 | 1;
  /** Only non-zero for role=tester: 1 when the file is a test or has tests. */
  testBearing: 0 | 1;
}

export interface RankedItem {
  path: string;
  tier: RankTier;
  score: number;
  components: RankComponents;
  reason: string;
}

export interface KeyFilesResult {
  role: Role;
  formula: string;
  weights: Weights;
  roleAdjustments: string[];
  candidates: number;
  tierSizes: { mustRead: number; readNext: number; skipForNow: number };
  tiers: {
    mustRead: RankedItem[];
    readNext: RankedItem[];
    skipForNow: { count: number; examples: string[] };
  };
  notes: string[];
}

const CODE_LANGS = new Set(['ts', 'js', 'py', 'go', 'c', 'cpp', 'h', 'java', 'kt', 'rs', 'rb', 'php', 'cs', 'swift', 'scala', 'shell', 'asm', 'css', 'handlebars']);

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

export function isReadme(path: string): boolean {
  return /^readme(\.[a-z]+)?$/i.test(baseName(path));
}

export function isTestFile(f: FileView): boolean {
  return f.meta.isTest === true || (f.meta.tags ?? []).includes('test');
}

/** Code, config and README files; data-like files (json/yaml/markdown/text/binary) only when config or README. */
export function isRankable(f: FileView): boolean {
  if (f.meta.isConfig === true || isReadme(f.path)) return true;
  return CODE_LANGS.has(f.meta.lang ?? '');
}

const coverCache = new WeakMap<GraphIndex, Map<string, string[]>>();

/** Test files covering `path`: meta.testedBy plus the inverse of other files' meta.testFor. */
export function testsCovering(idx: GraphIndex, path: string): string[] {
  let inverse = coverCache.get(idx);
  if (!inverse) {
    inverse = new Map();
    for (const f of idx.files.values()) for (const t of f.meta.testFor ?? []) inverse.set(t, [...(inverse.get(t) ?? []), f.path]);
    coverCache.set(idx, inverse);
  }
  const own = idx.files.get(path)?.meta.testedBy ?? [];
  return [...new Set([...own, ...(inverse.get(path) ?? [])])].sort();
}

const hasTests = (idx: GraphIndex, f: FileView): boolean => testsCovering(idx, f.path).length > 0;

const round = (n: number, d: number): number => {
  const k = 10 ** d;
  return Math.round(n * k) / k;
};

export function weightsFor(role: Role): { weights: Weights; adjustments: string[] } {
  const weights: Weights = { ...BASE_WEIGHTS };
  const adjustments: string[] = [];
  switch (role) {
    case 'reviewer':
      weights.churn = BASE_WEIGHTS.churn * 1.5;
      adjustments.push('reviewer: churn weight is 1.5x (1 -> 1.5) so recently changed areas rank higher.');
      break;
    case 'tester':
      weights.testBonus = 1;
      adjustments.push('tester: +1.0 for files that are tests or have tests (testBearing), and test files are included as candidates, so test-bearing modules rise.');
      break;
    case 'quick_look':
      adjustments.push(`quick_look: base formula, but only the Must read tier is returned, capped at ${QUICK_LOOK_CAP} files.`);
      break;
    default:
      adjustments.push('new_dev: base formula, no adjustments.');
  }
  return { weights, adjustments };
}

export function formulaFor(w: Weights): string {
  const bonus = w.testBonus ? ` + ${w.testBonus}*testBearing` : '';
  return `score = ${w.entry}*entry + ${w.fanIn}*fanInHat + ${w.config}*config + ${w.churn}*churnHat + ${w.docsMentions}*docsMentionsHat + ${w.tests}*tests${bonus}  (hat = metric / max over candidates)`;
}

export function scoreOf(c: RankComponents, w: Weights): number {
  return w.entry * c.entry + w.fanIn * c.fanInHat + w.config * c.config + w.churn * c.churnHat + w.docsMentions * c.docsMentionsHat + w.tests * c.tests + w.testBonus * c.testBearing;
}

export function reasonFor(f: FileView, c: RankComponents): string {
  const parts: string[] = [];
  if (c.entry) parts.push('entry point');
  if (c.config) parts.push('config file');
  if (isTestFile(f)) parts.push('test file');
  if (c.fanIn > 0) parts.push(`imported by ${c.fanIn} file${c.fanIn === 1 ? '' : 's'}`);
  if (c.churn > 0) parts.push(`changed ${c.churn} time${c.churn === 1 ? '' : 's'}`);
  if (c.docsMentions > 0) parts.push('mentioned in docs');
  if (c.tests) parts.push('has tests');
  return parts.length ? parts.join('; ') : 'no strong signals in the snapshot (no imports, history or doc mentions)';
}

export function candidateFiles(idx: GraphIndex, role: Role): FileView[] {
  return [...idx.files.values()].filter((f) => isRankable(f) && (role === 'tester' || !isTestFile(f)));
}

function tierCounts(n: number): { must: number; next: number } {
  if (n === 0) return { must: 0, next: 0 };
  const must = Math.max(1, Math.ceil(n * TIER_MUST_SHARE));
  const next = Math.min(n - must, Math.ceil(n * TIER_NEXT_SHARE));
  return { must, next };
}

/** Rank every candidate and split into tiers. Deterministic: score desc, then path. */
export function rankKeyFiles(idx: GraphIndex, role: Role, limit = DEFAULT_LIMIT): KeyFilesResult {
  const { weights, adjustments } = weightsFor(role);
  const cands = candidateFiles(idx, role);
  const max = (pick: (f: FileView) => number): number => cands.reduce((m, f) => Math.max(m, pick(f)), 0);
  const maxFanIn = max((f) => f.meta.fanIn ?? 0);
  const maxChurn = max((f) => f.meta.churn ?? 0);
  const maxDocs = max((f) => f.meta.docsMentions ?? 0);
  const hat = (v: number, m: number): number => (m > 0 ? v / m : 0);

  const scored = cands.map((f) => {
    const fanIn = f.meta.fanIn ?? 0;
    const churn = f.meta.churn ?? 0;
    const docsMentions = f.meta.docsMentions ?? 0;
    const components: RankComponents = {
      entry: f.meta.isEntry ? 1 : 0,
      fanIn,
      fanInHat: round(hat(fanIn, maxFanIn), 4),
      config: f.meta.isConfig ? 1 : 0,
      churn,
      churnHat: round(hat(churn, maxChurn), 4),
      docsMentions,
      docsMentionsHat: round(hat(docsMentions, maxDocs), 4),
      tests: hasTests(idx, f) ? 1 : 0,
      testBearing: role === 'tester' && (isTestFile(f) || hasTests(idx, f)) ? 1 : 0,
    };
    return { f, components, raw: scoreOf({ ...components, fanInHat: hat(fanIn, maxFanIn), churnHat: hat(churn, maxChurn), docsMentionsHat: hat(docsMentions, maxDocs) }, weights) };
  });
  scored.sort((a, b) => b.raw - a.raw || a.f.path.localeCompare(b.f.path));

  const { must, next } = tierCounts(scored.length);
  const items: RankedItem[] = scored.map((s, i) => ({
    path: s.f.path,
    tier: i < must ? 'Must read' : i < must + next ? 'Read next' : 'Skip for now',
    score: round(s.raw, 2),
    components: s.components,
    reason: reasonFor(s.f, s.components),
  }));

  const mustAll = items.filter((i) => i.tier === 'Must read');
  const nextAll = items.filter((i) => i.tier === 'Read next');
  const skipAll = items.filter((i) => i.tier === 'Skip for now');

  const notes: string[] = [];
  if (idx.snap.tier === 1) notes.push('Tier 1 snapshot: there is no import graph, so fan-in is 0 for every file and the ranking rests on entry, config, churn, docs mentions and tests only.');
  if (scored.length === 0) notes.push('No rankable files (code, config or README) were found in this snapshot.');
  if (idx.snap.truncated) notes.push('The snapshot is truncated, so some files are missing from the ranking.');
  if (maxChurn === 0) notes.push('No file has recorded churn (no history in the commit window), so the churn component is 0 for all files.');

  const quick = role === 'quick_look';
  const cap = quick ? Math.min(limit, QUICK_LOOK_CAP) : limit;
  const mustOut = mustAll.slice(0, cap);
  const nextOut = quick ? [] : nextAll.slice(0, limit);
  return {
    role,
    formula: formulaFor(weights),
    weights,
    roleAdjustments: adjustments,
    candidates: scored.length,
    tierSizes: { mustRead: mustAll.length, readNext: nextAll.length, skipForNow: skipAll.length },
    tiers: {
      mustRead: mustOut,
      readNext: nextOut,
      skipForNow: quick ? { count: nextAll.length + skipAll.length, examples: [] } : { count: skipAll.length, examples: skipAll.slice(0, 10).map((i) => i.path) },
    },
    notes,
  };
}
