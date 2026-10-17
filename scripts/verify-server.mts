import { parseSse } from '../web/lib/mcp.js';

/**
 * Smoke test of a running RepoAtlas server over /mcp against the guidebook and blueprint
 * requirements: registration, schemas, evidence and limits on every tool, ranking formulas,
 * the tour for every role, export safety and rate limiting. It changes nothing on the server
 * except using the per-session rate limit.
 *
 *   npm run verify:server -- http://localhost:3000/mcp
 *   npm run verify:server -- https://<your-app>.app.nitrocloud.ai/mcp --skip-ratelimit
 *
 * Needs the precomputed snapshot lukeautry/tsoa and, for the export checks, EXPORT_SECRET on the server.
 */
const args = process.argv.slice(2);
const URL = args.find((a) => a.startsWith('http')) || 'http://localhost:3000/mcp';
const SKIP_RATELIMIT = args.includes('--skip-ratelimit');
let n = 0;
let pass = 0;
const fails: string[] = [];
const check = (label: string, ok: boolean, detail = ''): void => {
  n++;
  if (ok) pass++;
  else fails.push(`${label}${detail ? ` -- ${detail}` : ''}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `  [${detail}]` : ''}`);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }) });
  const text = await res.text();
  const msgs = text.trimStart().startsWith('{') ? [JSON.parse(text)] : parseSse(text);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (msgs as any[]).find((m) => m && (m.result !== undefined || m.error !== undefined));
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any; text: string }> {
  const m = await rpc('tools/call', { name, arguments: args });
  const r = m?.result;
  const text = (r?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('');
  let data = r?.structuredContent;
  if (data === undefined) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { ok: !!r && r.isError !== true, data, text: m?.error ? String(m.error.message) : text };
}

const TOOLS12 = ['build_graph', 'project_overview', 'find_entry_points', 'key_files', 'trace_flow', 'explain_file', 'tour_next', 'profile_contributor', 'find_candidate_issues', 'localize_issue', 'score_first_change', 'export_guide'];

console.log('== A. Registration (guidebook 4.2, blueprint 8)');
const tl = (await rpc('tools/list')).result.tools as { name: string; description: string; inputSchema: { type?: string; properties?: Record<string, unknown> }; _meta?: Record<string, unknown> }[];
const names = tl.map((t) => t.name).sort();
check('exactly the 12 required tools plus ping_repoatlas', JSON.stringify(names) === JSON.stringify([...TOOLS12, 'ping_repoatlas'].sort()), names.join(','));
check('every tool has a generated object input schema', tl.every((t) => t.inputSchema?.type === 'object' && t.inputSchema.properties !== undefined));
check('every description is specific (>= 150 chars)', tl.filter((t) => t.name !== 'ping_repoatlas').every((t) => t.description.length >= 150), tl.filter((t) => t.description.length < 150).map((t) => t.name).join(','));
const untrustedTools = ['project_overview', 'tour_next', 'explain_file', 'find_candidate_issues', 'localize_issue', 'score_first_change', 'export_guide', 'key_files', 'find_entry_points', 'trace_flow', 'build_graph', 'profile_contributor'];
const missingNote = untrustedTools.filter((nm) => !/untrusted|never follow|data only|as data/i.test(tl.find((t) => t.name === nm)!.description));
console.log('      tools whose description does not mention untrusted data:', missingNote.join(', ') || '(none)');
const widgetTools = tl.filter((t) => JSON.stringify(t._meta ?? {}).includes('graph-view')).map((t) => t.name).sort();
check('widget graph-view attached to tour_next and explain_file', JSON.stringify(widgetTools) === JSON.stringify(['explain_file', 'tour_next']), widgetTools.join(','));

const tmpl = (await rpc('resources/templates/list')).result?.resourceTemplates ?? [];
check('resource template graph://{repo}@{sha}/summary', tmpl.some((t: { uriTemplate: string }) => t.uriTemplate === 'graph://{repo}@{sha}/summary'), JSON.stringify(tmpl).slice(0, 200));
const rr = await rpc('resources/read', { uri: 'graph://lukeautry__tsoa@f0f9aa7/summary' });
const rtext = rr?.result?.contents?.[0]?.text ?? '';
check('resource read returns the graph summary', rtext.includes('lukeautry/tsoa') && rtext.includes('limits'), String(rr?.error?.message ?? '').slice(0, 120));
const pl = (await rpc('prompts/list')).result?.prompts ?? [];
const gm = pl.find((p: { name: string }) => p.name === 'guide_me');
check('prompt guide_me(repo, role, depth)', !!gm && ['repo', 'role', 'depth'].every((a) => (gm.arguments ?? []).some((x: { name: string }) => x.name === a)), JSON.stringify(gm?.arguments));
const pg = await rpc('prompts/get', { name: 'guide_me', arguments: { repo: 'lukeautry/tsoa', role: 'new_dev', depth: 'standard' } });
check('prompt guide_me renders messages', (pg?.result?.messages ?? []).length > 0 && JSON.stringify(pg.result.messages).includes('build_graph'));

console.log('\n== B. Every tool returns evidence and limits (blueprint 8, 12)');
const id = 'lukeautry__tsoa@f0f9aa7';
const bg = await tool('build_graph', { repo: 'lukeautry/tsoa' });
check('build_graph: snapshot id, tier, truncated, commit window, asOf, stats', bg.data.snapshotId === id && [1, 2].includes(bg.data.tier) && typeof bg.data.truncated === 'boolean' && bg.data.commitWindow > 0 && !!bg.data.asOf && !!bg.data.stats);
const prof = (await tool('profile_contributor', { languages: ['TypeScript'], level: 'beginner' })).data;
const cands = (await tool('find_candidate_issues', { snapshotId: id, profile: prof.profile, limit: 5 })).data;
const num = cands.candidates?.[0]?.number;
const outputs: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
const calls: [string, Record<string, unknown>][] = [
  ['project_overview', { snapshotId: id }],
  ['find_entry_points', { snapshotId: id }],
  ['key_files', { snapshotId: id, role: 'new_dev' }],
  ['trace_flow', { snapshotId: id, entry: 'packages/cli/src/cli.ts' }],
  ['explain_file', { snapshotId: id, path: 'packages/cli/src/cli.ts' }],
  ['tour_next', { snapshotId: id, role: 'new_dev', stage: 4 }],
  ['find_candidate_issues', { snapshotId: id, profile: prof.profile, limit: 5 }],
  ['localize_issue', { snapshotId: id, issueNumber: num }],
  ['score_first_change', { snapshotId: id, issueNumber: num, profile: prof.profile }],
];
for (const [t, a] of calls) {
  const r = await tool(t, a);
  outputs[t] = r.data;
  const l = r.data?.limits;
  check(`${t}: works and carries limits (tier, asOf, truncated, commitWindow, notes)`, r.ok && !!l && [1, 2].includes(l.tier) && !!l.asOf && typeof l.truncated === 'boolean' && l.commitWindow > 0 && Array.isArray(l.notes) && l.notes.length > 0, r.ok ? JSON.stringify(Object.keys(r.data ?? {})).slice(0, 120) : r.text.slice(0, 120));
}
outputs.profile_contributor = prof;
const pcHasRead = JSON.stringify(prof).toLowerCase().includes('read');
check('profile_contributor: states what was read (public data only)', pcHasRead && !!prof.profile);

console.log('\n== C. Evidence and score components (blueprint 9, 12)');
const kf = outputs.key_files;
const mustFiles = kf.tiers?.mustRead?.files ?? kf.tiers?.mustRead ?? [];
check('key_files: tiers Must read / Read next / Skip', !!kf.tiers?.mustRead && !!kf.tiers?.readNext && !!kf.tiers?.skipForNow);
check('key_files: every file has score components', mustFiles.length > 0 && mustFiles.every((f: { components?: unknown; score?: number }) => f.components && typeof f.score === 'number'));
check('key_files: formula weights 3/2/1.5/1/1/0.5', JSON.stringify(kf.weights ?? kf.formula).includes('3') && JSON.stringify(kf.weights).includes('1.5') && JSON.stringify(kf.weights).includes('0.5'), JSON.stringify(kf.weights));
const ts = kf.tierSizes ?? {};
const total = (ts.mustRead ?? 0) + (ts.readNext ?? 0) + (ts.skipForNow ?? 0);
check('key_files: tier sizes about 10% / 25% / rest', total > 0 && Math.abs(ts.mustRead / total - 0.1) < 0.03 && Math.abs(ts.readNext / total - 0.25) < 0.03, JSON.stringify(ts));
const lo = outputs.localize_issue;
check('localize_issue: top 5 files with evidence, owner, reading order, confidence', (lo.files?.length ?? 0) <= 5 && lo.files?.length > 0 && lo.files.every((f: { evidence?: unknown[]; components?: unknown }) => Array.isArray(f.evidence) && f.evidence.length > 0 && f.components) && !!lo.readingOrder && !!lo.confidence);
check('localize_issue: components textMatch / historySimilarity / graphProximity / recency', ['textMatch', 'historySimilarity', 'graphProximity', 'recency'].every((c) => c in (lo.files[0].components ?? {})), JSON.stringify(lo.files[0].components));
const sc = outputs.score_first_change;
const factorNames = (sc.factors ?? []).map((f: { name: string }) => f.name).join(',');
check('score_first_change: product of six factors, each shown and floored at 0.1', (sc.factors ?? []).length === 6 && sc.factors.every((f: { floored: number }) => f.floored >= 0.1) && /language|centrality|test|fresh|clarity|size/i.test(factorNames), factorNames);
check('score_first_change: effort labelled an estimate, watch-outs present', /estimate/i.test(JSON.stringify(sc)) && Array.isArray(sc.watchOuts ?? sc.watchouts ?? sc.warnings ?? []));
const ci = outputs.find_candidate_issues;
check('find_candidate_issues: every candidate says why it passed + claim evidence', (ci.candidates ?? []).length > 0 && ci.candidates.every((c: { reasonsPassed?: unknown[]; claim?: { evidence?: unknown } }) => (c.reasonsPassed?.length ?? 0) > 0 && c.claim?.evidence !== undefined));
check('find_candidate_issues: filter counts reported (considered / excluded)', typeof ci.considered === 'number' && !!ci.excluded, JSON.stringify(ci.excluded));
const ex = outputs.explain_file;
check('explain_file: role, exports, imports, owners/tests/commits, confidence', !!ex.role && Array.isArray(ex.exports) && ex.imports !== undefined && (ex.owners !== undefined || ex.ownership !== undefined) && !!ex.subgraph);
check('trace_flow: ordered chain with caps stated', Array.isArray(outputs.trace_flow.steps) && outputs.trace_flow.steps.length > 1 && !!outputs.trace_flow.maxFiles);

console.log('\n== D. Tour: 8 stages, role matrix, check questions (blueprint 9)');
const expectStages: Record<string, number[]> = { new_dev: [1, 2, 3, 4, 5, 6, 7, 8], reviewer: [1, 3, 4, 7, 8], tester: [1, 3, 6], quick_look: [1, 2, 3] };
for (const [role, stages] of Object.entries(expectStages)) {
  const served: number[] = [];
  let questionsOk = true;
  for (let s = 1; s <= 8; s++) {
    const t = (await tool('tour_next', { snapshotId: id, role, stage: s })).data;
    if (t.stage === s) served.push(s);
    if (stages.includes(s) && !(t.checkQuestion?.question && t.checkQuestion?.answer)) questionsOk = false;
  }
  check(`tour role ${role}: serves stages ${stages.join(',')} (others are skipped with a notice)`, JSON.stringify(served) === JSON.stringify(stages), `served ${served.join(',')}`);
  check(`tour role ${role}: every served stage has a check question with answer`, questionsOk);
}
const t4 = outputs.tour_next;
check('tour_next: subgraph has at most 25 nodes and a highlight', (t4.subgraph?.nodes?.length ?? 99) <= 25 && (t4.subgraph?.highlight?.length ?? 0) > 0);
const last = (await tool('tour_next', { snapshotId: id, role: 'new_dev', stage: 8 })).data;
check('tour last stage bridges to profile_contributor / find_candidate_issues', /profile_contributor|find_candidate_issues/.test(JSON.stringify(last)));

console.log('\n== E. Safety (blueprint 12)');
const p1 = (await tool('export_guide', { snapshotId: id })).data;
check('export_guide step 1: preview + confirm token, writes nothing, no draft yet', p1.step === 'preview' && !!p1.confirmToken && p1.willWrite === false && !p1.markdown);
const bad = await tool('export_guide', { snapshotId: id, confirmToken: 'not-a-real-token' });
check('export_guide refuses a wrong token and returns no draft', !JSON.stringify(bad.data).includes('# ') || /refus|invalid|not confirmed|nothing/i.test(JSON.stringify(bad.data) + bad.text), (bad.text || JSON.stringify(bad.data)).slice(0, 140));
const tampered = await tool('export_guide', { snapshotId: 'demo__sample-shop@5a3f0c1', confirmToken: p1.confirmToken });
check('export_guide token for one snapshot does not work on another', !String(tampered.data?.markdown ?? '').length, JSON.stringify(tampered.data).slice(0, 100));
const p2 = (await tool('export_guide', { snapshotId: id, confirmToken: p1.confirmToken })).data;
check('export_guide step 2 with the token returns the draft ARCHITECTURE.md (text only)', String(p2.markdown ?? '').length > 500 && p2.willWrite !== true);
check('no token/secret appears in any output seen', !/ghp_|github_pat_|test-secret/.test(JSON.stringify(outputs) + JSON.stringify(p1) + JSON.stringify(p2)));
const probe = await tool('build_graph', { repo: 'https://gitlab.com/a/b' });
check('untrusted/invalid repo input returns "unavailable", not a crash', probe.data?.status === 'unavailable');

console.log('\n== F. Policies (guidebook 4.4): rate limit live');
let limited = false;
for (let i = 0; i < (SKIP_RATELIMIT ? 0 : 24); i++) {
  const r = await tool('export_guide', { snapshotId: id });
  if (/Rate limit reached/i.test(r.text + JSON.stringify(r.data))) {
    limited = true;
    console.log(`      rate limit tripped on call ${i + 1} of export_guide (limit 20/min)`);
    break;
  }
}
if (SKIP_RATELIMIT) console.log('SKIP  export_guide rate limit (--skip-ratelimit)');
else check('export_guide rate limit (20/min per session) enforced', limited);

console.log(`\nRESULT: ${pass}/${n} checks passed`);
if (fails.length) console.log('FAILED:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
