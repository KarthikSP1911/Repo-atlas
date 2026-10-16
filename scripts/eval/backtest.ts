/**
 * hit@5 backtest for localize_issue on merged PRs, using only the issue text.
 *
 *   npm run eval:backtest [-- --refresh] [-- --per-repo 20]
 *
 * For each eligible merged PR (an exact "fixes" link to an issue, 1 to 8 changed non-test files
 * that still exist in the snapshot) the snapshot is rewound to just before the PR was opened
 * (see snapshotBefore), localize_issue is run on the issue's title and body, and we check
 * whether a file the PR really changed is in the top 5. Writes docs/eval/backtest.json and
 * docs/eval/backtest-prs.csv. Needs GITHUB_TOKEN once to fetch issue bodies and PR author
 * association; the fetched data is cached in scripts/eval/.cache.
 */
import * as fs from 'node:fs/promises';
import { LOCALIZE } from '../../src/config/weights.js';
import { localizeIssue, isTestFile } from '../../src/services/localize.service.js';
import { GraphIndex } from '../../src/services/graph.query.js';
import { CACHE_DIR, csvRow, fetchPrDetails, graphqlOrNull, loadDemos, mean, pct, randomHitAt, readCache, snapshotBefore, writeCache, type Demo, type PrDetails } from './common.js';

type Weights = { a: number; b: number; c: number; d: number };
type Row = { path: string; textMatch: number; historySimilarity: number; graphProximity: number; recency: number };
type Klass = 'first-timer' | 'contributor' | 'maintainer' | 'other';

interface Case {
  repo: string;
  pr: number;
  issue: number;
  klass: Klass;
  association: string;
  real: string[];
  /** Files that could have been ranked at all (the localization candidate pool). */
  poolSize: number;
  rows: Row[];
  fanIn: Record<string, number>;
  historyPrsUsed: number;
}

const DATA_EXT = /\.(png|jpe?g|gif|svg|ico|webp|pdf|zip|gz|lock|map|snap|json|sum|csv|tsv)$/i;
const klassOf = (assoc: string): Klass =>
  assoc === 'FIRST_TIMER' || assoc === 'FIRST_TIME_CONTRIBUTOR' ? 'first-timer' : assoc === 'CONTRIBUTOR' ? 'contributor' : ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(assoc) ? 'maintainer' : 'other';

const DEFAULT_W: Weights = { a: LOCALIZE.a, b: LOCALIZE.b, c: LOCALIZE.c, d: LOCALIZE.d };

export function rank(rows: Row[], w: Weights): string[] {
  return rows
    .map((r) => ({ p: r.path, s: w.a * r.textMatch + w.b * r.historySimilarity + w.c * r.graphProximity + w.d * r.recency }))
    .sort((x, y) => y.s - x.s || x.p.localeCompare(y.p))
    .map((x) => x.p);
}

function score(cases: Case[], order: (c: Case) => string[]): { hit5: number; recall5: number; mrr: number; n: number } {
  const hits: number[] = [];
  const recalls: number[] = [];
  const rr: number[] = [];
  for (const c of cases) {
    const ranked = order(c);
    const top = new Set(ranked.slice(0, 5));
    const real = new Set(c.real);
    const inTop = c.real.filter((f) => top.has(f)).length;
    hits.push(inTop > 0 ? 1 : 0);
    recalls.push(inTop / real.size);
    const first = ranked.findIndex((p) => real.has(p));
    rr.push(first >= 0 ? 1 / (first + 1) : 0);
  }
  return { hit5: mean(hits), recall5: mean(recalls), mrr: mean(rr), n: cases.length };
}

function* simplex(step: number): Generator<Weights> {
  const n = Math.round(1 / step);
  for (let a = 0; a <= n; a++) for (let b = 0; b <= n - a; b++) for (let c = 0; c <= n - a - b; c++) yield { a: a * step, b: b * step, c: c * step, d: (n - a - b - c) * step };
}

function bestWeights(cases: Case[], step = 0.05): { w: Weights; hit5: number; mrr: number } {
  let best = { w: DEFAULT_W, hit5: -1, mrr: -1, dist: Infinity };
  for (const w of simplex(step)) {
    const s = score(cases, (c) => rank(c.rows, w));
    const dist = Math.abs(w.a - DEFAULT_W.a) + Math.abs(w.b - DEFAULT_W.b) + Math.abs(w.c - DEFAULT_W.c) + Math.abs(w.d - DEFAULT_W.d);
    // Prefer hit@5, then MRR, then the weights closest to the defaults (less change for the same score).
    if (s.hit5 > best.hit5 + 1e-9 || (Math.abs(s.hit5 - best.hit5) < 1e-9 && (s.mrr > best.mrr + 1e-9 || (Math.abs(s.mrr - best.mrr) < 1e-9 && dist < best.dist)))) best = { w, hit5: s.hit5, mrr: s.mrr, dist };
  }
  return { w: best.w, hit5: best.hit5, mrr: best.mrr };
}

async function buildCases(demo: Demo, perRepo: number, refresh: boolean): Promise<{ cases: Case[]; notes: string[] }> {
  const notes: string[] = [];
  const idx = demo.idx;
  const fileSet = new Set(idx.files.keys());
  const eligible = idx.prs
    .filter((p) => p.mergedAt && p.author && !/\[bot\]$/i.test(p.author))
    .map((p) => ({ p, real: p.files.filter((f) => fileSet.has(f) && !DATA_EXT.test(f) && !isTestFile(f, idx.files.get(f)?.meta.isTest)), exact: p.fixes.filter((x) => x.confidence === 'exact' && idx.issues.get(x.issue) && !idx.issues.get(x.issue)!.stub) }))
    .filter((x) => x.exact.length > 0 && x.real.length >= 1 && x.real.length <= 8)
    .sort((a, b) => (b.p.mergedAt ?? '').localeCompare(a.p.mergedAt ?? ''))
    .slice(0, 70);
  notes.push(`${demo.repo}: ${idx.prs.length} merged PRs in the snapshot, ${eligible.length} eligible (exact issue link, 1 to 8 changed non-test files still in the repo; newest 70 kept).`);

  const cacheName = `prdetails-${demo.id}.json`;
  let details = refresh ? null : await readCache<PrDetails[]>(cacheName);
  if (!details) {
    const gql = graphqlOrNull();
    if (!gql) throw new Error('GITHUB_TOKEN is not set in .env: needed once to fetch issue bodies and PR author association for the backtest.');
    const got = await fetchPrDetails(gql, demo.repo, eligible.map((x) => x.p.number));
    details = got.details;
    await writeCache(cacheName, details);
    notes.push(`${demo.repo}: fetched ${details.length} PR details in ${got.calls} GitHub call(s), cost ${got.cost}.`);
  }
  const byNumber = new Map(details.map((d) => [d.number, d]));

  const usable = eligible
    .map((x) => ({ ...x, d: byNumber.get(x.p.number) }))
    .filter((x) => x.d && x.d.createdAt && x.d.issues.some((i) => `${i.title} ${i.body}`.trim().length >= 30))
    .map((x) => ({ ...x, klass: klassOf(x.d!.association) }));
  // Prefer first-time contributors, then other contributors, then maintainers; newest first within each.
  const order: Klass[] = ['first-timer', 'contributor', 'other', 'maintainer'];
  const picked = order.flatMap((k) => usable.filter((x) => x.klass === k)).slice(0, perRepo);
  notes.push(`${demo.repo}: ${usable.length} PRs have usable issue text; evaluating ${picked.length} (${order.map((k) => `${picked.filter((x) => x.klass === k).length} ${k}`).join(', ')}).`);

  const cases: Case[] = [];
  for (const x of picked) {
    const d = x.d!;
    const issue = [...d.issues].sort((a, b) => `${b.title} ${b.body}`.length - `${a.title} ${a.body}`.length)[0];
    const cutoff = new Date(Date.parse(d.createdAt) - 7 * 86_400_000).toISOString();
    const rewound = snapshotBefore(demo.snap, cutoff);
    const idx2 = new GraphIndex(rewound);
    let rows: Row[] = [];
    localizeIssue(idx2, { title: issue.title, body: issue.body, number: issue.number }, { topFiles: 5, onCandidates: (r) => (rows = r) });
    const fanIn: Record<string, number> = {};
    for (const r of rows) fanIn[r.path] = idx2.files.get(r.path)?.meta.fanIn ?? 0;
    cases.push({
      repo: demo.repo,
      pr: x.p.number,
      issue: issue.number,
      klass: x.klass,
      association: d.association,
      real: x.real,
      poolSize: [...idx2.files.values()].filter((f) => !DATA_EXT.test(f.path) && !isTestFile(f.path, f.meta.isTest)).length,
      rows,
      fanIn,
      historyPrsUsed: idx2.prs.length,
    });
  }
  return { cases, notes };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const refresh = argv.includes('--refresh');
  const perRepo = Number(argv[argv.indexOf('--per-repo') + 1]) || 20;
  const demos = await loadDemos();
  const all: Case[] = [];
  const notes: string[] = [];
  for (const demo of demos) {
    const r = await buildCases(demo, perRepo, refresh);
    all.push(...r.cases);
    notes.push(...r.notes);
  }
  if (all.length === 0) throw new Error('No eligible PRs found.');
  for (const n of notes) console.log(n);

  const line = (label: string, s: ReturnType<typeof score>): string => `${label.padEnd(34)} hit@5 ${pct(s.hit5).padStart(4)}  recall@5 ${pct(s.recall5).padStart(4)}  MRR ${s.mrr.toFixed(2)}  (n=${s.n})`;
  const variants: { name: string; w: Weights }[] = [
    { name: 'default weights', w: DEFAULT_W },
    { name: 'text match only', w: { a: 1, b: 0, c: 0, d: 0 } },
    { name: 'history similarity only', w: { a: 0, b: 1, c: 0, d: 0 } },
    { name: 'text + history (no graph, no recency)', w: { a: 0.6, b: 0.4, c: 0, d: 0 } },
    { name: 'recency only', w: { a: 0, b: 0, c: 0, d: 1 } },
  ];
  const result: Record<string, unknown> = { generatedAt: new Date().toISOString(), perRepoTarget: perRepo, notes, byVariant: {}, byRepo: {}, byClass: {} };

  console.log('\n== All evaluated PRs ==');
  for (const v of variants) {
    const s = score(all, (c) => rank(c.rows, v.w));
    (result.byVariant as Record<string, unknown>)[v.name] = { weights: v.w, ...s };
    console.log(line(v.name, s));
  }
  const fanInBase = score(all, (c) => Object.keys(c.fanIn).sort((x, y) => c.fanIn[y] - c.fanIn[x] || x.localeCompare(y)));
  const random = mean(all.map((c) => randomHitAt(c.poolSize, c.real.length)));
  (result.byVariant as Record<string, unknown>)['baseline: top 5 by fan-in'] = fanInBase;
  (result.byVariant as Record<string, unknown>)['baseline: random 5 files'] = { hit5: random, n: all.length };
  console.log(line('baseline: top 5 by fan-in', fanInBase));
  console.log(`${'baseline: random 5 files'.padEnd(34)} hit@5 ${pct(random).padStart(4)}  (expected, from pool sizes)`);

  console.log('\n== Default weights by repo ==');
  for (const repo of [...new Set(all.map((c) => c.repo))]) {
    const cs = all.filter((c) => c.repo === repo);
    const s = score(cs, (c) => rank(c.rows, DEFAULT_W));
    (result.byRepo as Record<string, unknown>)[repo] = { ...s, tier1: demos.find((d) => d.repo === repo)?.snap.tier === 1, randomHit5: mean(cs.map((c) => randomHitAt(c.poolSize, c.real.length))) };
    console.log(line(repo, s) + `  random ${pct(mean(cs.map((c) => randomHitAt(c.poolSize, c.real.length))))}`);
  }
  console.log('\n== Default weights by PR author class ==');
  for (const k of ['first-timer', 'contributor', 'other', 'maintainer'] as Klass[]) {
    const cs = all.filter((c) => c.klass === k);
    if (!cs.length) continue;
    const s = score(cs, (c) => rank(c.rows, DEFAULT_W));
    (result.byClass as Record<string, unknown>)[k] = s;
    console.log(line(k, s));
  }

  // Weight tuning with 2-fold cross-validation (folds by PR number parity) so the number we report is held out.
  console.log('\n== Weight tuning (grid step 0.05, 2-fold cross-validation) ==');
  const foldA = all.filter((c) => c.pr % 2 === 0);
  const foldB = all.filter((c) => c.pr % 2 === 1);
  const tuneA = bestWeights(foldA);
  const tuneB = bestWeights(foldB);
  const cvTuned = score(foldB, (c) => rank(c.rows, tuneA.w));
  const cvTuned2 = score(foldA, (c) => rank(c.rows, tuneB.w));
  const cvHit = (cvTuned.hit5 * cvTuned.n + cvTuned2.hit5 * cvTuned2.n) / (cvTuned.n + cvTuned2.n);
  const cvMrr = (cvTuned.mrr * cvTuned.n + cvTuned2.mrr * cvTuned2.n) / (cvTuned.n + cvTuned2.n);
  const defaultAll = score(all, (c) => rank(c.rows, DEFAULT_W));
  const full = bestWeights(all);
  const fmt = (w: Weights): string => `a=${w.a.toFixed(2)} b=${w.b.toFixed(2)} c=${w.c.toFixed(2)} d=${w.d.toFixed(2)}`;
  console.log(`default ${fmt(DEFAULT_W)}: hit@5 ${pct(defaultAll.hit5)} MRR ${defaultAll.mrr.toFixed(2)} (all ${all.length}, not held out)`);
  console.log(`tuned on even PRs ${fmt(tuneA.w)} -> held-out hit@5 ${pct(cvTuned.hit5)} (n=${cvTuned.n}); default on same: ${pct(score(foldB, (c) => rank(c.rows, DEFAULT_W)).hit5)}`);
  console.log(`tuned on odd PRs  ${fmt(tuneB.w)} -> held-out hit@5 ${pct(cvTuned2.hit5)} (n=${cvTuned2.n}); default on same: ${pct(score(foldA, (c) => rank(c.rows, DEFAULT_W)).hit5)}`);
  console.log(`cross-validated tuned hit@5 ${pct(cvHit)} MRR ${cvMrr.toFixed(2)} vs default ${pct(defaultAll.hit5)} MRR ${defaultAll.mrr.toFixed(2)}`);
  console.log(`best on all PRs (in-sample, optimistic) ${fmt(full.w)}: hit@5 ${pct(full.hit5)} MRR ${full.mrr.toFixed(2)}`);
  result.tuning = {
    default: { weights: DEFAULT_W, hit5: defaultAll.hit5, mrr: defaultAll.mrr },
    foldEvenTuned: tuneA.w,
    foldOddTuned: tuneB.w,
    crossValidated: { hit5: cvHit, mrr: cvMrr, n: all.length },
    bestInSample: { weights: full.w, hit5: full.hit5, mrr: full.mrr },
  };
  result.total = all.length;

  await fs.mkdir('docs/eval', { recursive: true });
  await fs.writeFile('docs/eval/backtest.json', JSON.stringify(result, null, 2) + '\n');
  const header = csvRow(['repo', 'pr', 'issue', 'author_class', 'real_files', 'candidates', 'rank_of_first_real', 'hit_at_5_default', 'history_prs_available']);
  const rowsCsv = all.map((c) => {
    const ranked = rank(c.rows, DEFAULT_W);
    const first = ranked.findIndex((p) => c.real.includes(p));
    return csvRow([c.repo, c.pr, c.issue, c.klass, c.real.length, c.rows.length, first >= 0 ? first + 1 : 'not ranked', first >= 0 && first < 5 ? 1 : 0, c.historyPrsUsed]);
  });
  await fs.writeFile('docs/eval/backtest-prs.csv', [header, ...rowsCsv].join('\n') + '\n');
  console.log(`\nWrote docs/eval/backtest.json and docs/eval/backtest-prs.csv (cache: ${CACHE_DIR}).`);
}

main().then(() => process.exit(0), (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
