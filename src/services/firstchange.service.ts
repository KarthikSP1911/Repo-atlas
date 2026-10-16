import { FIRST_CHANGE } from '../config/weights.js';
import type { GraphIndex } from './graph.query.js';
import type { OpenIssue } from './issues.schema.js';
import { claimEvidence, clarityOf, daysBetween, type ClaimEvidence } from './issues.service.js';
import { localizeIssue, safeLabel, type Confidence, type IssueInput, type LocalizeResult, type LocalizedFile } from './localize.service.js';
import type { Profile } from './profile.types.js';

/**
 * score_first_change engine: how good a first contribution is this issue for this person?
 *
 *   score = languageFit x (1 - centrality) x testPresence x freshness x clarity x sizeFit(level)
 *
 * Each factor is floored at FIRST_CHANGE.factorFloor so one weak signal lowers the score without
 * zeroing it. Raw value, floored value and a one-line reason are returned for every factor.
 * Issue text is UNTRUSTED data: it is measured, never obeyed.
 */

// Local constants (not blueprint weights; the lead may move them to weights.ts).
const LOCAL = {
  /** Partial credit when the file is ts and the person knows js (or the reverse). */
  relatedLanguageCredit: 0.6,
  /** A file this central (0..1) or imported by this many files is flagged as a watch-out. */
  centralCentrality: 0.4,
  centralFanIn: 10,
  /** Files this long are flagged as large. */
  largeFileLoc: 800,
  /** Files within this share of the top score count as "to touch" for the size estimate. */
  touchShare: 0.5,
  /** Clarity below this adds an "issue is unclear" watch-out. */
  unclearBelow: 0.5,
  /** Freshness below this adds a "no recent activity" watch-out. */
  staleBelow: 0.25,
  /** Language ids that carry no language skill requirement (prose). */
  neutralLangs: ['markdown'],
  maxWatchOuts: 10,
} as const;

export type FactorName = 'languageFit' | 'centrality' | 'testPresence' | 'freshness' | 'clarity' | 'sizeFit';

export interface Factor {
  name: FactorName;
  /** Value before flooring (0..1). */
  raw: number;
  /** max(factorFloor, raw): what enters the product. */
  floored: number;
  explanation: string;
}

export interface FirstChangeOpts {
  /** Score these paths instead of running localization. */
  files?: string[];
  /** The issue as stored in the issues file: enables the claim check. */
  openIssue?: OpenIssue;
  /** When the issues file was fetched ("now" for freshness and claims). */
  issuesFetchedAt?: string;
  includeTests?: boolean;
}

export interface FirstChangeResult {
  /** 0..1, 3 decimals. */
  score: number;
  formula: string;
  factors: Factor[];
  files: LocalizedFile[];
  readingOrder: string[];
  /** How many files the size factor assumed would change. */
  estimatedFileCount: number;
  estimatedEffort: string;
  watchOuts: string[];
  whoToAsk: string[];
  whyItFits: string;
  claim: (ClaimEvidence & { asOf: string }) | null;
  confidence: Confidence;
  confidenceReasons: string[];
  issue: LocalizeResult['issue'];
  /** Paths passed in `files` that are not in the snapshot. */
  unknownFiles: string[];
  notes: string[];
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const FORMULA = `languageFit x (1 - centrality) x testPresence x freshness x clarity x sizeFit(level), each factor floored at ${FIRST_CHANGE.factorFloor}`;

function factor(name: FactorName, raw: number, explanation: string): Factor {
  const r = clamp01(raw);
  return { name, raw: round3(r), floored: Math.max(FIRST_CHANGE.factorFloor, round3(r)), explanation };
}

/** Size-fit by level: 1.0 up to idealMax, linear down to the floor at hardMax. */
export function sizeFitRaw(files: number, level: string): number {
  const [, ideal, hard] = FIRST_CHANGE.sizeByLevel[level] ?? FIRST_CHANGE.sizeByLevel.intermediate;
  if (files <= ideal) return 1;
  const floor = FIRST_CHANGE.factorFloor;
  if (hard <= ideal) return floor;
  return Math.max(0, 1 - ((1 - floor) * (files - ideal)) / (hard - ideal));
}

function languageCredit(lang: string | undefined, known: Set<string>): number {
  const l = (lang ?? '').toLowerCase();
  if (!l) return 0;
  if (LOCAL.neutralLangs.includes(l as never) || known.has(l)) return 1;
  if ((l === 'ts' && known.has('js')) || (l === 'js' && known.has('ts'))) return LOCAL.relatedLanguageCredit;
  return 0;
}

function effortOf(n: number, loc: number): string {
  const band = loc <= 200 && n <= 2 ? 'a few hours' : loc <= 600 && n <= 4 ? 'about 1 to 2 days' : loc <= 1500 && n <= 8 ? 'about 2 to 4 days' : 'about a week or more';
  return `Estimate only (a rough guess from file count and size, not a promise): ${band}, for ${n} file${n === 1 ? '' : 's'} and about ${loc} lines of existing code to read.`;
}

function filesFromPaths(idx: GraphIndex, paths: string[]): { files: LocalizedFile[]; unknown: string[] } {
  const files: LocalizedFile[] = [];
  const unknown: string[] = [];
  for (const raw of [...new Set(paths)]) {
    const f = idx.resolvePath(raw).file;
    if (!f) {
      unknown.push(raw.slice(0, 200));
      continue;
    }
    if (files.some((x) => x.path === f.path)) continue;
    const ownerId = f.meta.owners?.[0];
    files.push({
      path: f.path,
      score: 1,
      components: { textMatch: 0, historySimilarity: 0, graphProximity: 0, recency: 0 },
      evidence: ['file chosen by the caller (localization was skipped)'],
      owner: ownerId ? safeLabel(idx.personLabel(ownerId)) : null,
      tests: (f.meta.testedBy ?? []).slice(0, 3),
      lang: f.meta.lang,
      relatedPrs: [],
      relatedIssues: [],
    });
  }
  return { files, unknown };
}

export function scoreFirstChange(idx: GraphIndex, issue: IssueInput, profile: Profile, opts: FirstChangeOpts = {}): FirstChangeResult {
  const notes: string[] = [];
  let loc: LocalizeResult;
  let unknownFiles: string[] = [];
  if (opts.files && opts.files.length) {
    const given = filesFromPaths(idx, opts.files);
    unknownFiles = given.unknown;
    const confidenceReasons = ['files were supplied by the caller, so no localization confidence applies'];
    loc = {
      files: given.files,
      readingOrder: given.files.map((f) => f.path),
      confidence: given.files.length ? 'medium' : 'low',
      confidenceReasons,
      issue: { number: issue.number ?? null, title: issue.title.slice(0, 200), labels: (issue.labels ?? []).slice(0, 10), url: issue.url ?? null, untrusted: true },
      queryTerms: [],
      notes: [],
    };
    if (unknownFiles.length) notes.push(`${unknownFiles.length} supplied path${unknownFiles.length === 1 ? ' is' : 's are'} not in this snapshot and were ignored.`);
  } else {
    loc = localizeIssue(idx, issue, { includeTests: opts.includeTests });
    notes.push(...loc.notes);
  }
  const files = loc.files;
  const known = new Set(profile.languages.map((l) => l.trim().toLowerCase()).filter(Boolean));
  const meta = (p: string) => idx.files.get(p)!.meta;
  const n = files.length;

  // languageFit
  const credits = files.map((f) => languageCredit(meta(f.path).lang, known));
  const langRaw = n ? credits.reduce((a, b) => a + b, 0) / n : 0;
  const partial = files.filter((_, i) => credits[i] > 0 && credits[i] < 1).length;
  const langFactor = factor(
    'languageFit',
    langRaw,
    n
      ? `${credits.filter((c) => c === 1).length} of ${n} files are in languages you know${partial ? ` and ${partial} in a related one (ts/js, ${pct(LOCAL.relatedLanguageCredit)} credit)` : ''}.`
      : 'No files were localized, so language fit is unknown.',
  );

  // centrality
  const meanCentrality = n ? files.reduce((a, f) => a + (meta(f.path).centrality ?? 0), 0) / n : 0;
  const centralFactor = factor(
    'centrality',
    1 - meanCentrality,
    idx.snap.tier === 1
      ? 'Tier 1 snapshot has no import graph, so centrality is 0 for every file and this factor cannot penalise risky files.'
      : `Mean centrality of the files is ${meanCentrality.toFixed(2)}; the factor is 1 minus that (central files are riskier to change).`,
  );

  // testPresence
  const tested = files.filter((f) => (meta(f.path).testedBy?.length ?? 0) > 0 || meta(f.path).isTest === true);
  const testFactor = factor('testPresence', n ? tested.length / n : 0, n ? `${tested.length} of ${n} files have tests (or are tests), so a change can be checked.` : 'No files were localized, so test presence is unknown.');

  // freshness
  let freshRaw = 1;
  let freshExplain = 'No issue date available (free text), so freshness is 1.0.';
  let staleDays: number | null = null;
  if (issue.updatedAt && opts.issuesFetchedAt) {
    staleDays = daysBetween(issue.updatedAt, opts.issuesFetchedAt);
    freshRaw = Math.pow(0.5, staleDays / FIRST_CHANGE.freshnessHalfLifeDays);
    freshExplain = `Last activity ${Math.round(staleDays)} days before the issues were fetched; half-life ${FIRST_CHANGE.freshnessHalfLifeDays} days.`;
  }
  const freshFactor = factor('freshness', freshRaw, freshExplain);

  // clarity
  const clarity = clarityOf({ title: issue.title, body: issue.body });
  const clarityFactor = factor('clarity', clarity.score, clarity.signals.length ? `Issue text shows: ${clarity.signals.join(', ')}.` : 'Issue text shows no clarity signals (short, no reproduction or expected behaviour).');

  // sizeFit
  const top = files[0]?.score ?? 0;
  const touch = n ? Math.max(1, files.filter((f) => f.score >= LOCAL.touchShare * top).length) : 1;
  const [, ideal, hard] = FIRST_CHANGE.sizeByLevel[profile.level] ?? FIRST_CHANGE.sizeByLevel.intermediate;
  const sizeFactor = factor(
    'sizeFit',
    sizeFitRaw(touch, profile.level),
    `Likely ${touch} file${touch === 1 ? '' : 's'} to change; for a ${profile.level} the ideal is up to ${ideal} and ${hard} or more is too big.`,
  );

  const factors = [langFactor, centralFactor, testFactor, freshFactor, clarityFactor, sizeFactor];
  const product = factors.reduce((a, f) => a * f.floored, 1);
  const score = Math.max(0.001, round3(product));

  // Size / effort.
  const touched = files.filter((f) => f.score >= LOCAL.touchShare * top).slice(0, touch);
  const totalLoc = touched.reduce((a, f) => a + (meta(f.path).loc ?? 0), 0);

  // Watch-outs.
  const watch: string[] = [];
  const untested = files.filter((f) => !((meta(f.path).testedBy?.length ?? 0) > 0 || meta(f.path).isTest === true));
  for (const f of untested.slice(0, 3)) watch.push(`touches ${f.path} which has no tests`);
  if (untested.length > 3) watch.push(`${untested.length - 3} more localized files have no tests`);
  for (const f of files) {
    const m = meta(f.path);
    if ((m.centrality ?? 0) >= LOCAL.centralCentrality || (m.fanIn ?? 0) >= LOCAL.centralFanIn) {
      watch.push(`central file ${f.path} (imported by ${m.fanIn ?? 0} files): changes here can break many callers`);
    }
    if ((m.loc ?? 0) >= LOCAL.largeFileLoc) watch.push(`${f.path} is large (${m.loc} lines)`);
  }
  if (clarity.score < LOCAL.unclearBelow) {
    const missing: string[] = [];
    if (!clarity.signals.includes('reproduction steps')) missing.push('no reproduction steps');
    if (!clarity.signals.includes('expected behaviour or acceptance hint')) missing.push('no expected behaviour');
    if (!clarity.clearEnough) missing.push('very little description');
    watch.push(`issue is unclear: ${missing.join(', ') || 'few clarity signals'}; ask a maintainer before starting`);
  }
  if (idx.snap.tier === 1) watch.push('snapshot is tier 1: no import data, so side effects on other files cannot be checked here');
  if (idx.snap.truncated) watch.push('snapshot is truncated: some files may be missing from this analysis');
  if (n && langRaw < 1) {
    const off = files.filter((_, i) => credits[i] === 0).map((f) => f.path);
    if (off.length) watch.push(`${off.slice(0, 2).join(', ')}${off.length > 2 ? ' and others' : ''} ${off.length === 1 ? 'is' : 'are'} in a language outside your list`);
  }
  if (staleDays !== null && freshRaw < LOCAL.staleBelow) watch.push(`no activity on the issue for about ${Math.round(staleDays)} days; confirm it is still wanted`);
  if (loc.confidence === 'low' || n === 0) watch.push(`localization confidence is low (${loc.confidenceReasons[0] ?? 'no reason recorded'}), so treat the file list as a starting guess`);

  // Claim.
  let claim: FirstChangeResult['claim'] = null;
  if (opts.openIssue && opts.issuesFetchedAt) {
    claim = { ...claimEvidence(opts.openIssue, opts.issuesFetchedAt), asOf: opts.issuesFetchedAt };
    if (claim.claimed) watch.push(`issue may already be claimed: ${claim.evidence.join('; ')}`);
    if (claim.maybeFixed) watch.push(`issue may already be fixed: ${claim.evidence.join('; ')}`);
  }

  // Who to ask.
  const me = profile.username?.toLowerCase();
  const asks: string[] = [];
  for (const f of files) {
    if (f.owner && f.owner.toLowerCase() !== me && !asks.includes(f.owner)) asks.push(f.owner);
  }

  // Why it fits.
  const areas = profile.familiarAreas.map((a) => a.toLowerCase()).filter(Boolean);
  const areaHit = areas.find((a) => files.some((f) => f.path.toLowerCase().includes(a) || (meta(f.path).tags ?? []).some((t) => t.toLowerCase() === a)));
  const sentences: string[] = [];
  if (n === 0) {
    sentences.push('No files could be matched to this issue, so the score only reflects the issue text and its age.');
  } else {
    sentences.push(
      `It likely needs ${touch} file${touch === 1 ? '' : 's'} (${touched.slice(0, 2).map((f) => f.path).join(', ')}${touch > 2 ? ', ...' : ''}), ${touch <= ideal ? `which suits a ${profile.level} contributor` : `which is on the large side for a ${profile.level} contributor`}.`,
    );
    sentences.push(`${pct(langRaw)} of the files are in languages you know and ${tested.length} of ${n} have tests${areaHit ? `; it also sits in your familiar area "${areaHit}"` : ''}.`);
  }
  sentences.push(`The issue text is ${clarity.score >= 0.6 ? 'fairly clear' : clarity.score >= LOCAL.unclearBelow ? 'reasonably clear' : 'vague'} (clarity ${clarity.score.toFixed(2)}) and overall fit is ${score.toFixed(2)} out of 1.`);

  return {
    score,
    formula: FORMULA,
    factors,
    files,
    readingOrder: loc.readingOrder,
    estimatedFileCount: touch,
    estimatedEffort: effortOf(touch, totalLoc),
    watchOuts: [...new Set(watch)].slice(0, LOCAL.maxWatchOuts),
    whoToAsk: asks.slice(0, 3),
    whyItFits: sentences.join(' '),
    claim,
    confidence: loc.confidence,
    confidenceReasons: loc.confidenceReasons,
    issue: loc.issue,
    unknownFiles,
    notes,
  };
}
