/**
 * Generates the hand-check sheets the project owner fills in. The tool's own claims are in the
 * left columns; the columns starting with "human_" are left blank for a person to answer by
 * opening each issue on GitHub.
 *
 *   npm run eval:handcheck
 *
 * docs/eval/handcheck-candidates.csv : the top 10 candidates for one demo repo.
 * docs/eval/handcheck-claims.csv     : 20 issues labelled "likely unclaimed", across the demo repos.
 * docs/eval/handcheck-keyfiles.csv   : the top 10 Must read files per demo repo (the maintainers' docs
 *                                      name too few files to score key_files automatically).
 */
import * as fs from 'node:fs/promises';
import { findCandidates } from '../../src/services/candidates.service.js';
import { rankKeyFiles } from '../../src/services/rank.service.js';
import { csvRow, loadDemos } from './common.js';

const PROFILE = { languages: ['ts', 'js', 'py', 'go'], level: 'intermediate' as const, familiarAreas: [] };

async function main(): Promise<void> {
  const demos = (await loadDemos()).filter((d) => d.issues);
  await fs.mkdir('docs/eval', { recursive: true });

  const primary = demos.find((d) => d.repo === 'lukeautry/tsoa') ?? demos[0];
  const top = findCandidates(primary.issues!, PROFILE, 10);
  const header1 = ['repo', 'issue', 'url', 'title', 'labels', 'tool_says_unclaimed_because', 'tool_clarity_signals', 'days_since_activity', 'human_is_really_open', 'human_is_really_unclaimed', 'human_is_reasonable_for_a_newcomer', 'human_notes'];
  const rows1 = top.candidates.map((c) => csvRow([primary.repo, c.number, c.url, c.title, c.labels.join('; '), c.claim.evidence.join(' | '), c.clarity.signals.join('; '), c.freshness.daysSinceActivity, '', '', '', '']));
  await fs.writeFile('docs/eval/handcheck-candidates.csv', [csvRow(header1), ...rows1].join('\n') + '\n');

  // 20 "likely unclaimed" issues spread across the repos (round robin over each repo's ranked candidates).
  const lists = demos.map((d) => ({ d, c: findCandidates(d.issues!, PROFILE, 25).candidates }));
  const picked: { repo: string; c: (typeof lists)[number]['c'][number] }[] = [];
  for (let i = 0; picked.length < 20 && lists.some((l) => i < l.c.length); i++) for (const l of lists) if (i < l.c.length && picked.length < 20) picked.push({ repo: l.d.repo, c: l.c[i] });
  const header2 = ['repo', 'issue', 'url', 'title', 'tool_says', 'evidence', 'human_is_it_really_unclaimed (yes/no)', 'human_notes'];
  const rows2 = picked.map((p) => csvRow([p.repo, p.c.number, p.c.url, p.c.title, p.c.claim.label, p.c.claim.evidence.join(' | '), '', '']));
  await fs.writeFile('docs/eval/handcheck-claims.csv', [csvRow(header2), ...rows2].join('\n') + '\n');

  const header3 = ['repo', 'path', 'score', 'tool_reason', 'human_would_a_maintainer_call_it_essential (yes/no)', 'human_notes'];
  const rows3: string[] = [];
  for (const d of await loadDemos()) for (const k of rankKeyFiles(d.idx, 'new_dev', 10).tiers.mustRead.slice(0, 10)) rows3.push(csvRow([d.repo, k.path, k.score, k.reason, '', '']));
  await fs.writeFile('docs/eval/handcheck-keyfiles.csv', [csvRow(header3), ...rows3].join('\n') + '\n');

  console.log(`Wrote docs/eval/handcheck-keyfiles.csv (${rows3.length} files). Wrote docs/eval/handcheck-candidates.csv (${rows1.length} issues from ${primary.repo}) and docs/eval/handcheck-claims.csv (${rows2.length} issues).`);
}

main().then(() => process.exit(0), (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
