import MiniSearch from 'minisearch';
import { LOCALIZE } from '../config/weights.js';
import type { GraphIndex } from './graph.query.js';
import type { IssuesFile, OpenIssue } from './issues.schema.js';
import { MS_PER_DAY } from './issues.service.js';

/**
 * localize_issue engine: given an issue (by number or free text), rank the files most likely to
 * need changing. Pure and synchronous over a GraphIndex.
 *
 *   score = a*textMatch + b*historySimilarity + c*graphProximity + d*recency      (a..d from LOCALIZE)
 *
 * Every component is scaled to 0..1 and returned, so the ranking is explainable. All issue text,
 * PR/commit titles and file docstrings are UNTRUSTED data: they are tokenised and measured,
 * never interpreted as instructions.
 */

// Local tuning constants that are not blueprint weights (the lead may move them to weights.ts).
const TUNING = {
  /** Issue body is cut to this many characters before use. */
  bodyMaxChars: 2000,
  /** BM25 field boosts for the per-file document. */
  fieldBoost: { path: 2, symbols: 2, doc: 1 } as Record<string, number>,
  /** Text-match files used as seeds for graph proximity. */
  graphSeeds: 3,
  /** A neighbour gets at least this share of the seed score; the rest scales with edge weight. */
  edgeBase: 0.5,
  /** Similar PRs/commits considered for history credit. */
  historyTop: 8,
  /** Ignore history documents whose similarity is below this. */
  historyMinSim: 0.15,
  /** PRs/commits touching more files than this are refactors/merges: skipped as noise. */
  historyMaxFiles: 40,
  /** Query terms a history document must cover (capped) to reach full similarity. */
  historyCoverageTerms: 4,
  /** Below this many distinct query terms the issue text counts as too short to trust. */
  minTerms: 3,
  /** Evidence lines per history source. */
  evidencePerFile: 2,
} as const;

export interface IssueInput {
  title: string;
  body: string;
  number?: number;
  labels?: string[];
  url?: string;
  /** ISO time of the last issue activity, when the issue came from the issues file. */
  updatedAt?: string;
}

export interface LocalizeOpts {
  /** Let test files compete with source files (default false: they only show up under `tests`). */
  includeTests?: boolean;
  /** Number of files to return (default LOCALIZE.topFiles). */
  topFiles?: number;
  /** Override the a, b, c, d weights (used by the evaluation scripts to tune them). */
  weights?: { a: number; b: number; c: number; d: number };
  /**
   * Called with the raw 0..1 components of every candidate file before they are weighted, so the
   * evaluation can re-rank under other weights without re-running BM25.
   */
  onCandidates?: (rows: { path: string; textMatch: number; historySimilarity: number; graphProximity: number; recency: number }[]) => void;
}

export interface Components {
  textMatch: number;
  historySimilarity: number;
  graphProximity: number;
  recency: number;
}

export interface LocalizedFile {
  path: string;
  score: number;
  components: Components;
  evidence: string[];
  owner: string | null;
  tests: string[];
  lang?: string;
  /** Merged PR numbers whose titles resembled the issue and that touched this file. */
  relatedPrs: number[];
  /** Issue numbers those PRs fixed. */
  relatedIssues: number[];
}

export type Confidence = 'high' | 'medium' | 'low';

export interface LocalizeResult {
  files: LocalizedFile[];
  /** Read dependencies before dependents; ties by score. */
  readingOrder: string[];
  confidence: Confidence;
  confidenceReasons: string[];
  /** Echo of the issue; title and labels are untrusted text. */
  issue: { number: number | null; title: string; labels: string[]; url: string | null; untrusted: true };
  /** Distinct query terms used (processed form), at most 25. */
  queryTerms: string[];
  notes: string[];
}

// --- Text processing -----------------------------------------------------------

const STOP = new Set(
  (
    'a an and are as at be been but by can could do does did for from had has have how if in into is it its may might more most no not of on or our out so some such than that the their them then there these they this those to too up was we were what when where which while who why will with would you your ' +
    'issue bug feature request expected actual behavior behaviour version versions step steps reproduce using use used get got need needs want wants should please thanks thank description describe problem also like just one new ' +
    'const let var function return import export await async def self func nil true false null undefined class type string number'
  ).split(' '),
);

function stem(t: string): string {
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}

/** Lowercase word tokens: camelCase and separators split, stop words and numbers dropped, plurals folded. */
export function tokenize(text: string): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOP.has(t))
    .map(stem);
}

/** Drop URLs, emails, markdown and fence markers; keep identifiers inside code (stack traces help). */
export function cleanIssueText(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, ' ')
    .replace(/```[A-Za-z0-9_-]*/g, ' ')
    .replace(/<[^>]{1,80}>/g, ' ')
    .replace(/[`*_>#|~]+/g, ' ');
}

interface Query {
  /** Pre-tokenised query string for MiniSearch (title terms twice). */
  text: string;
  terms: string[];
}

function buildQuery(issue: IssueInput, drop: Set<string>): Query {
  const keep = (t: string): boolean => !drop.has(t);
  const title = [...new Set(tokenize(cleanIssueText(issue.title)).filter(keep))];
  const body = [...new Set(tokenize(cleanIssueText(issue.body.slice(0, TUNING.bodyMaxChars))).filter(keep))];
  const terms = [...new Set([...title, ...body])];
  return { text: [...title, ...title, ...body].join(' '), terms };
}

// --- File classification -------------------------------------------------------

const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs|testdata|fixtures?|e2e)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const DATA_EXT_RE = /\.(png|jpe?g|gif|svg|ico|webp|pdf|zip|gz|tgz|woff2?|ttf|eot|mp[34]|csv|tsv|lock|map|snap|min\.js|json|sum)$/i;
const DATA_NAME_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum)$/i;

export function isTestFile(path: string, isTest?: boolean): boolean {
  return isTest === true || TEST_RE.test(path);
}

function isDataLike(path: string): boolean {
  return DATA_EXT_RE.test(path) || DATA_NAME_RE.test(path);
}

function pathTokens(path: string): string[] {
  return tokenize(path.replace(/\.[A-Za-z0-9]+$/, '').replace(/(^|\/)src(\/|$)/g, '/'));
}

// --- Cached indexes -------------------------------------------------------------

interface TextIndex {
  ms: MiniSearch;
}

interface HistoryDoc {
  id: string;
  kind: 'pr' | 'commit';
  ref: string;
  number?: number;
  title: string;
  files: string[];
  fixes: number[];
}

interface HistoryIndex {
  ms: MiniSearch;
  docs: Map<string, HistoryDoc>;
}

const textCache = new WeakMap<GraphIndex, Map<boolean, TextIndex>>();
const historyCache = new WeakMap<GraphIndex, HistoryIndex>();

const newSearch = (fields: string[]): MiniSearch =>
  new MiniSearch({ fields, idField: 'id', tokenize: (s) => s.split(/\s+/).filter(Boolean), processTerm: (t) => t });

function textIndexFor(idx: GraphIndex, includeTests: boolean): TextIndex {
  let byMode = textCache.get(idx);
  if (!byMode) textCache.set(idx, (byMode = new Map()));
  const hit = byMode.get(includeTests);
  if (hit) return hit;
  const ms = newSearch(['path', 'symbols', 'doc']);
  const docs = [];
  for (const f of idx.files.values()) {
    if (isDataLike(f.path)) continue;
    if (!includeTests && isTestFile(f.path, f.meta.isTest)) continue;
    docs.push({
      id: f.path,
      path: pathTokens(f.path).join(' '),
      symbols: tokenize([...(f.meta.exports ?? []), ...(f.meta.symbols ?? [])].join(' ')).join(' '),
      doc: tokenize(f.meta.doc ?? '').join(' '),
    });
  }
  ms.addAll(docs);
  const built = { ms };
  byMode.set(includeTests, built);
  return built;
}

function historyIndexFor(idx: GraphIndex): HistoryIndex {
  const hit = historyCache.get(idx);
  if (hit) return hit;
  const ms = newSearch(['text']);
  const docs = new Map<string, HistoryDoc>();
  const prNumbers = new Set<number>();
  for (const pr of idx.prs) {
    if (!pr.files.length || pr.files.length > TUNING.historyMaxFiles) continue;
    const fixes = pr.fixes.map((f) => f.issue);
    prNumbers.add(pr.number);
    docs.set(pr.id, { id: pr.id, kind: 'pr', ref: `PR #${pr.number}`, number: pr.number, title: pr.title, files: pr.files, fixes });
  }
  for (const c of idx.commits) {
    if (!c.files.length || c.files.length > TUNING.historyMaxFiles) continue;
    if (c.prNumber !== undefined && prNumbers.has(c.prNumber)) continue; // the PR already carries these files
    docs.set(c.id, { id: c.id, kind: 'commit', ref: `commit ${c.sha7}`, title: c.subject, files: c.files, fixes: [] });
  }
  ms.addAll(
    [...docs.values()].map((d) => {
      const fixedTitles = d.fixes.map((n) => idx.issues.get(n)).filter((i) => i && !i.stub).map((i) => i!.title);
      return { id: d.id, text: tokenize([d.title, ...fixedTitles].join(' ')).join(' ') };
    }),
  );
  const built = { ms, docs };
  historyCache.set(idx, built);
  return built;
}

// --- Helpers --------------------------------------------------------------------

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const oneLine = (s: string, max = 80): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A person label that can never be an email address. */
export function safeLabel(label: string): string {
  return label.includes('@') ? label.split('@')[0] || 'unknown' : label;
}

function recencyOf(lastChangedAt: string | undefined, asOf: string): { value: number; known: boolean } {
  const t = lastChangedAt ? Date.parse(lastChangedAt) : NaN;
  const ref = Date.parse(asOf);
  if (!Number.isFinite(t) || !Number.isFinite(ref)) return { value: 0.5, known: false };
  const days = Math.max(0, (ref - t) / MS_PER_DAY);
  return { value: Math.pow(0.5, days / LOCALIZE.recencyHalfLifeDays), known: true };
}

export function issueFromOpen(o: OpenIssue): IssueInput {
  return { title: o.title, body: o.body, number: o.number, labels: o.labels, url: o.url, updatedAt: o.updatedAt };
}

export interface ResolvedIssue {
  issue: IssueInput;
  /** Present when the issue came from the issues file. */
  open?: OpenIssue;
  notes: string[];
}

/**
 * Pick the issue to work on: by number from the issues file, or from free text. Throws an Error
 * with a recoverable message when neither works.
 */
export function resolveIssue(file: IssuesFile | null, input: { issueNumber?: number; title?: string; body?: string }): ResolvedIssue {
  const title = input.title?.trim() ?? '';
  const body = input.body?.trim() ?? '';
  const notes: string[] = [];
  if (input.issueNumber === undefined && !title && !body) {
    throw new Error('Pass issueNumber (an open issue from this snapshot) or title/body text describing the issue.');
  }
  if (input.issueNumber !== undefined) {
    const open = file?.issues.find((i) => i.number === input.issueNumber);
    if (open) return { issue: issueFromOpen(open), open, notes };
    if (!file) {
      if (title || body) {
        notes.push(`This snapshot has no issues file, so issue #${input.issueNumber} was not looked up; the text you passed was used instead.`);
        return { issue: { title, body, number: input.issueNumber }, notes };
      }
      throw new Error(`This snapshot has no issues file, so issue #${input.issueNumber} cannot be looked up. Pass title and body text instead.`);
    }
    const sample = [...file.issues]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.number - b.number)
      .slice(0, 6)
      .map((i) => `#${i.number}`);
    throw new Error(`Issue #${input.issueNumber} is not among the ${file.issues.length} open issues in this snapshot's issues file.${sample.length ? ` Valid numbers include ${sample.join(', ')}.` : ''} Or pass title/body text.`);
  }
  return { issue: { title, body }, notes };
}

// --- Main -----------------------------------------------------------------------

interface HistoryCredit {
  credit: number;
  sources: { ref: string; title: string; sim: number; number?: number; fixes: number[] }[];
}

export function localizeIssue(idx: GraphIndex, issue: IssueInput, opts: LocalizeOpts = {}): LocalizeResult {
  const includeTests = opts.includeTests === true;
  const topN = Math.max(1, opts.topFiles ?? LOCALIZE.topFiles);
  // The repo name appears in almost every file and issue, so it carries no signal.
  const query = buildQuery(issue, new Set(tokenize(idx.repo.split('/')[1] ?? '')));
  const echo: LocalizeResult['issue'] = {
    number: issue.number ?? null,
    title: oneLine(issue.title, 200),
    labels: (issue.labels ?? []).slice(0, 10).map((l) => oneLine(l, 40)),
    url: issue.url ?? null,
    untrusted: true,
  };
  const notes: string[] = [];
  const empty = (reason: string): LocalizeResult => ({
    files: [],
    readingOrder: [],
    confidence: 'low',
    confidenceReasons: [reason],
    issue: echo,
    queryTerms: query.terms.slice(0, 25),
    notes: [...notes, reason],
  });
  if (query.terms.length === 0) return empty('The issue text has no usable words after cleaning, so no files can be ranked.');

  // 1. textMatch: BM25 over path tokens, symbols and doc line.
  const text = textIndexFor(idx, includeTests);
  const textHits = text.ms.search(query.text, { combineWith: 'OR', boost: TUNING.fieldBoost });
  const topText = textHits[0]?.score ?? 0;
  const textScore = new Map<string, number>();
  const textTerms = new Map<string, { terms: string[]; fields: string[] }>();
  const matchedTerms = new Set<string>();
  for (const h of textHits) {
    textScore.set(h.id as string, h.score / topText);
    const fields = new Set<string>();
    for (const t of h.terms) {
      matchedTerms.add(t);
      for (const f of h.match[t] ?? []) fields.add(f);
    }
    textTerms.set(h.id as string, { terms: [...h.terms], fields: [...fields] });
  }

  // 2. historySimilarity: similar merged PRs / fixed-issue titles / commit subjects credit the files they touched.
  const hist = historyIndexFor(idx);
  const historyCredit = new Map<string, HistoryCredit>();
  const histHits = hist.ms.search(query.text, { combineWith: 'OR' });
  const histTop = histHits[0]?.score ?? 0;
  const coverageDen = Math.max(1, Math.min(query.terms.length, TUNING.historyCoverageTerms));
  let historyUsed = 0;
  for (const h of histHits) {
    if (historyUsed >= TUNING.historyTop) break;
    const doc = hist.docs.get(h.id as string);
    if (!doc) continue;
    const sim = (h.score / histTop) * Math.min(1, h.terms.length / coverageDen);
    if (sim < TUNING.historyMinSim) continue;
    let used = false;
    for (const p of doc.files) {
      const f = idx.files.get(p);
      if (!f || isDataLike(p) || (!includeTests && isTestFile(p, f.meta.isTest))) continue;
      const entry = historyCredit.get(p) ?? { credit: 0, sources: [] };
      entry.credit += sim / Math.sqrt(doc.files.length);
      entry.sources.push({ ref: doc.ref, title: doc.title, sim, number: doc.number, fixes: doc.fixes });
      historyCredit.set(p, entry);
      used = true;
    }
    if (used) historyUsed++;
    for (const t of h.terms) matchedTerms.add(t);
  }
  const topCredit = Math.max(0, ...[...historyCredit.values()].map((c) => c.credit));
  const historyScore = (p: string): number => (topCredit > 0 ? (historyCredit.get(p)?.credit ?? 0) / topCredit : 0);

  // 3. graphProximity: one-hop import neighbours of the best text matches (none on tier 1).
  const graphScore = new Map<string, number>();
  const graphVia = new Map<string, string>();
  const seeds = [...textScore.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TUNING.graphSeeds);
  for (const [seed, seedScore] of seeds) {
    const links = [...idx.imports(seed), ...idx.importedBy(seed)];
    const maxW = Math.max(1, ...links.map((l) => l.weight));
    for (const l of links) {
      const f = idx.files.get(l.path);
      if (!f || l.path === seed || isDataLike(l.path) || (!includeTests && isTestFile(l.path, f.meta.isTest))) continue;
      const credit = seedScore * (TUNING.edgeBase + (1 - TUNING.edgeBase) * (l.weight / maxW));
      if (credit > (graphScore.get(l.path) ?? 0)) {
        graphScore.set(l.path, credit);
        graphVia.set(l.path, seed);
      }
    }
  }

  // 4. combine.
  const candidates = new Set<string>([...textScore.keys(), ...historyCredit.keys(), ...graphScore.keys()]);
  const ranked: LocalizedFile[] = [];
  const W = opts.weights ?? LOCALIZE;
  const rawRows: { path: string; textMatch: number; historySimilarity: number; graphProximity: number; recency: number }[] = [];
  for (const p of candidates) {
    const f = idx.files.get(p);
    if (!f) continue;
    const t = clamp01(textScore.get(p) ?? 0);
    const h = clamp01(historyScore(p));
    const g = clamp01(graphScore.get(p) ?? 0);
    const rec = recencyOf(f.meta.lastChangedAt, idx.snap.builtAt);
    rawRows.push({ path: p, textMatch: t, historySimilarity: h, graphProximity: g, recency: rec.value });
    const total = W.a * t + W.b * h + W.c * g + W.d * rec.value;

    const evidence: string[] = [];
    const tt = textTerms.get(p);
    if (tt) evidence.push(`matches terms: ${tt.terms.slice(0, 6).join(', ')} (in ${tt.fields.join(', ')})`);
    const cr = historyCredit.get(p);
    const relatedPrs: number[] = [];
    const relatedIssues: number[] = [];
    if (cr) {
      const top = [...cr.sources].sort((a, b) => b.sim - a.sim || a.ref.localeCompare(b.ref));
      for (const s of top.slice(0, TUNING.evidencePerFile)) {
        evidence.push(`${s.ref} "${oneLine(s.title)}" touched it (similarity ${s.sim.toFixed(2)})`);
      }
      for (const s of top) {
        if (s.number !== undefined) relatedPrs.push(s.number);
        for (const n of s.fixes) relatedIssues.push(n);
      }
      if (relatedIssues.length) evidence.push(`those changes fixed issue${relatedIssues.length > 1 ? 's' : ''} ${[...new Set(relatedIssues)].slice(0, 3).map((n) => `#${n}`).join(', ')}`);
    }
    const via = graphVia.get(p);
    if (via) evidence.push(`imports/imported by ${via}`);
    if (f.meta.lastChangedAt) evidence.push(`last changed ${f.meta.lastChangedAt.slice(0, 10)}`);

    const ownerId = f.meta.owners?.[0];
    ranked.push({
      path: p,
      score: round3(total),
      components: { textMatch: round3(t), historySimilarity: round3(h), graphProximity: round3(g), recency: round3(rec.value) },
      evidence,
      owner: ownerId ? safeLabel(idx.personLabel(ownerId)) : null,
      tests: (f.meta.testedBy ?? []).slice(0, 3),
      lang: f.meta.lang,
      relatedPrs: [...new Set(relatedPrs)],
      relatedIssues: [...new Set(relatedIssues)],
    });
  }
  opts.onCandidates?.(rawRows);
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const files = ranked.slice(0, topN);

  if (files.length === 0) return empty('No file, pull request or commit in this snapshot resembles the issue text.');

  // Confidence.
  const reasons: string[] = [];
  let pts = 0;
  const matchedShare = matchedTerms.size / query.terms.length;
  if (matchedTerms.size >= 3 && matchedShare >= 0.2) {
    pts++;
    reasons.push(`${matchedTerms.size} of ${query.terms.length} issue terms matched files or history`);
  } else {
    reasons.push(`only ${matchedTerms.size} of ${query.terms.length} issue terms matched anything`);
  }
  const margin = files.length > 1 ? files[0].score - files[files.length - 1].score : files[0].score;
  const lead = files.length > 1 ? files[0].score - files[1].score : files[0].score;
  if (lead >= 0.05 && margin >= 0.15) {
    pts++;
    reasons.push(`top file leads the runner-up by ${lead.toFixed(2)} and file #${files.length} by ${margin.toFixed(2)}`);
  } else {
    reasons.push(`scores are close together (top leads runner-up by ${lead.toFixed(2)}, last place by ${margin.toFixed(2)})`);
  }
  const agree = files.slice(0, 3).find((f) => f.components.textMatch > 0 && f.components.historySimilarity > 0);
  if (agree) {
    pts++;
    reasons.push(`text and history agree on ${agree.path}`);
  } else {
    reasons.push('text match and history point at different files (or history found nothing)');
  }
  const strong = files[0].components.textMatch >= 0.99 && (textTerms.get(files[0].path)?.terms.length ?? 0) >= 2;
  if (strong) {
    pts++;
    reasons.push(`top file matches ${textTerms.get(files[0].path)!.terms.length} terms by path/symbols/doc`);
  }
  if (idx.snap.tier === 1) {
    pts--;
    reasons.push('snapshot is tier 1: no import graph, so graph proximity is unavailable');
  }
  if (idx.snap.truncated) {
    pts--;
    reasons.push('snapshot is truncated: some files are missing from the graph');
  }
  const clearLead = lead >= 0.05 && margin >= 0.15;
  let confidence: Confidence = pts >= 3 && clearLead && agree ? 'high' : pts >= 2 ? 'medium' : 'low';
  if (query.terms.length < TUNING.minTerms) {
    confidence = 'low';
    reasons.unshift(`the issue text is very short (${query.terms.length} usable term${query.terms.length === 1 ? '' : 's'})`);
  }

  return {
    files,
    readingOrder: readingOrderOf(idx, files),
    confidence,
    confidenceReasons: reasons,
    issue: echo,
    queryTerms: query.terms.slice(0, 25),
    notes,
  };
}

/** Dependencies first: a file is read after the returned files it imports. Cycles and ties fall back to score. */
export function readingOrderOf(idx: GraphIndex, files: Pick<LocalizedFile, 'path' | 'score'>[]): string[] {
  const inSet = new Set(files.map((f) => f.path));
  const score = new Map(files.map((f) => [f.path, f.score]));
  const deps = new Map<string, Set<string>>();
  for (const f of files) deps.set(f.path, new Set(idx.imports(f.path).map((l) => l.path).filter((p) => inSet.has(p) && p !== f.path)));
  const order: string[] = [];
  const left = new Set(inSet);
  const best = (set: Iterable<string>): string => [...set].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || a.localeCompare(b))[0];
  while (left.size) {
    const ready = [...left].filter((p) => [...deps.get(p)!].every((d) => !left.has(d)));
    const next = best(ready.length ? ready : left);
    order.push(next);
    left.delete(next);
  }
  return order;
}
