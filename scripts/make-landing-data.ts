/**
 * Generates web/data/example.json: every number and example the landing page shows, taken from the
 * shipped snapshot (lukeautry/tsoa) and docs/eval/backtest.json, so the page cannot drift from the
 * product.   npm run landing:data
 */
import * as fs from 'node:fs/promises';
import { findCandidates } from '../src/services/candidates.service.js';
import { scoreFirstChange } from '../src/services/firstchange.service.js';
import { GraphIndex } from '../src/services/graph.query.js';
import { issueFromOpen, localizeIssue } from '../src/services/localize.service.js';
import { rankKeyFiles } from '../src/services/rank.service.js';
import { StoreService } from '../src/services/store.service.js';
import { tourStop } from '../src/services/tour.service.js';
import { limitsOf } from '../src/services/tool.util.js';
import { layoutSubgraph, subgraphOf } from '../src/widgets/app/graph-view/graph-layout.js';

const REPO = 'lukeautry__tsoa@f0f9aa7';

const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The widget's drawing as a static SVG, from the real tour_next result and the widget's own layout code. */
function renderGraphSvg(output: unknown, title: string): string {
  const sg = subgraphOf(output);
  if (!sg) throw new Error('no subgraph to render');
  const L = layoutSubgraph(sg);
  const selected = sg.nodes.find((n) => n.highlight) ?? sg.nodes[0];
  const W = L.width + 24;
  const H = L.height + 64;
  const c = { bg: '#000000', panel: '#0a0a0a', text: '#ededed', muted: '#a1a1a1', border: '#2e2e2e', node: '#141414', focus: '#3291ff', focusFill: '#0a1f3a', edge: '#6b6b6b', hot: '#3291ff' };
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" font-family="system-ui, Segoe UI, sans-serif">`);
  parts.push(`<defs><marker id="a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${c.edge}"/></marker><marker id="h" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${c.hot}"/></marker></defs>`);
  parts.push(`<rect width="${W}" height="${H}" rx="12" fill="${c.bg}" stroke="${c.border}"/>`);
  parts.push(`<text x="16" y="26" font-size="15" font-weight="700" fill="${c.text}">${esc(title)}</text>`);
  parts.push(`<text x="${W - 16}" y="26" font-size="12" text-anchor="end" fill="${c.muted}">${sg.nodes.length} files</text>`);
  parts.push(`<g transform="translate(12,40)"><rect width="${L.width}" height="${L.height}" rx="8" fill="${c.panel}" stroke="${c.border}"/>`);
  for (const e of L.edges) {
    const hot = e.from === selected.id || e.to === selected.id;
    parts.push(`<path d="${e.d}" fill="none" stroke="${hot ? c.hot : c.edge}" stroke-width="${hot ? 1.8 : 0.9}" opacity="${hot ? 0.95 : 0.35}" marker-end="url(#${hot ? 'h' : 'a'})"/>`);
  }
  for (const p of L.nodes) {
    const label = p.node.label.length > 26 ? `${p.node.label.slice(0, 25)}…` : p.node.label;
    parts.push(`<g><rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="7" fill="${p.node.highlight ? c.focusFill : c.node}" stroke="${p.node.highlight ? c.focus : c.border}" stroke-width="${p.node.highlight ? 2 : 1}"/><text x="${p.x + p.w / 2}" y="${p.y + p.h / 2 + 4}" text-anchor="middle" font-size="11.5" fill="${c.text}" font-weight="${p.node.highlight ? 700 : 400}">${esc(label)}</text></g>`);
  }
  parts.push('</g></svg>');
  return parts.join('\n');
}


async function main(): Promise<void> {
  const store = new StoreService();
  store.dir = 'data/snapshots';
  const snap = await store.load(REPO);
  const issues = await store.loadIssues(REPO);
  if (!issues) throw new Error('tsoa issues file missing');
  const idx = new GraphIndex(snap);
  const limits = limitsOf(snap);

  const keyFiles = rankKeyFiles(idx, 'new_dev', 5).tiers.mustRead.slice(0, 5).map((k) => ({ path: k.path, score: k.score, reason: k.reason }));
  const tour = tourStop(idx, 'new_dev', 4);
  const core = (tour.content.coreModules as { path: string; fanIn: number }[]).slice(0, 3).map((m) => ({ path: m.path, fanIn: m.fanIn }));

  const profile = { languages: ['ts'], level: 'beginner' as const, familiarAreas: [] as string[] };
  const cands = findCandidates(issues, profile, 10);
  // Score every shortlisted issue for this profile and feature the best fit (the first one in the
  // list is ranked by clarity and freshness only, and is not always the best first change).
  const scored = cands.candidates.map((c) => {
    const open = issues.issues.find((i) => i.number === c.number)!;
    const input = issueFromOpen(open);
    return { c, open, input, loc: localizeIssue(idx, input), score: scoreFirstChange(idx, input, profile, { openIssue: open, issuesFetchedAt: issues.fetchedAt }) };
  });
  scored.sort((x, y) => y.score.score - x.score.score || x.c.number - y.c.number);
  const best = scored[0];
  const top = best.c;
  const loc = best.loc;
  const score = best.score;

  const bt = JSON.parse(await fs.readFile('docs/eval/backtest.json', 'utf8')) as {
    total: number;
    byVariant: Record<string, { hit5: number; recall5?: number; mrr?: number; n?: number }>;
    byRepo: Record<string, { hit5: number; n: number }>;
  };

  const data = {
    generatedAt: new Date().toISOString(),
    snapshot: { id: limits.snapshotId, repo: snap.repo, asOf: limits.asOf, tier: limits.tier, files: idx.files.size, importEdges: snap.edges.filter((e) => e.kind === 'imports').length, mergedPrs: idx.prs.length, commitWindow: snap.commitWindow },
    keyFiles,
    tour: { stage: tour.stage, name: tour.name, progress: tour.progress, question: tour.checkQuestion.question, coreModules: core },
    candidates: scored.slice(0, 3).map((x) => ({ number: x.c.number, title: x.c.title, url: x.c.url, labels: x.c.labels, evidence: x.c.claim.evidence[0], rankScore: x.c.rankScore, firstChangeScore: x.score.score, filesToChange: x.score.estimatedFileCount })),
    candidateFilters: { considered: cands.considered, excluded: cands.excluded, passed: cands.considered - Object.values(cands.excluded).reduce((a, b) => a + b, 0), scoredForProfile: scored.length },
    profile,
    localize: { issue: top.number, issueTitle: top.title, issueUrl: top.url, confidence: loc.confidence, files: loc.files.slice(0, 3).map((f) => ({ path: f.path, score: f.score, evidence: f.evidence[0] ?? '' })) },
    firstChange: { issue: top.number, score: score.score, whyItFits: score.whyItFits, factors: score.factors.map((f) => ({ name: f.name, floored: Number(f.floored.toFixed(2)) })), effort: score.estimatedEffort, watchOuts: score.watchOuts.slice(0, 2) },
    accuracy: {
      prs: bt.total,
      hit5: bt.byVariant['default weights'].hit5,
      recall5: bt.byVariant['default weights'].recall5,
      random: bt.byVariant['baseline: random 5 files'].hit5,
      fanIn: bt.byVariant['baseline: top 5 by fan-in'].hit5,
      byRepo: Object.entries(bt.byRepo).map(([repo, v]) => ({ repo, hit5: v.hit5, n: v.n })),
    },
    tools: ['build_graph', 'project_overview', 'find_entry_points', 'key_files', 'trace_flow', 'explain_file', 'tour_next', 'profile_contributor', 'find_candidate_issues', 'localize_issue', 'score_first_change', 'export_guide'],
  };
  // The web demo draws the same graph as the widget, so it uses a verbatim copy of the layout module.
  const layoutSrc = await fs.readFile('src/widgets/app/graph-view/graph-layout.ts', 'utf8');
  await fs.mkdir('web/lib', { recursive: true });
  await fs.writeFile('web/lib/graph-layout.ts', `// GENERATED by npm run landing:data from src/widgets/app/graph-view/graph-layout.ts. Do not edit.\n${layoutSrc}`);
  await fs.mkdir('web/public/screens', { recursive: true });
  await fs.writeFile('web/public/screens/tour-stage-4.svg', renderGraphSvg(tour, `${tour.progress}: ${tour.name}`));
  await fs.mkdir('web/data', { recursive: true });
  await fs.writeFile('web/data/example.json', JSON.stringify(data, null, 2) + '\n');
  console.log(`web/data/example.json written: ${keyFiles.length} key files, ${data.candidates.length} candidates, hit@5 ${(data.accuracy.hit5 * 100).toFixed(0)}% over ${data.accuracy.prs} PRs.`);
}

main().then(() => process.exit(0), (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
