/**
 * key_files accuracy: how much of what each repo's own maintainers say matters shows up in the
 * Must read tier?
 *
 *   npm run eval:keyfiles
 *
 * "Maintainers' listed files" are the files and folders that CONTRIBUTING, ARCHITECTURE,
 * DEVELOPMENT, README-style docs name explicitly (an exact path match, from the snapshot's
 * `describes` edges). Repos whose docs name fewer than 3 candidate files cannot be scored, and
 * the report says so instead of inventing a number. Writes docs/eval/keyfiles.json.
 */
import * as fs from 'node:fs/promises';
import { candidateFiles, rankKeyFiles } from '../../src/services/rank.service.js';
import { loadDemos, pct } from './common.js';

const MAINTAINER_DOC = /(contributing|architecture|development|hacking|design|readme)/i;

async function main(): Promise<void> {
  const out: Record<string, unknown> = { generatedAt: new Date().toISOString(), repos: {} };
  for (const demo of await loadDemos()) {
    const idx = demo.idx;
    const docs = idx.docs.filter((d) => MAINTAINER_DOC.test(d.path.slice(d.path.lastIndexOf('/') + 1)) || /architecture/i.test(d.path));
    const listedFiles = new Set<string>();
    const listedDirs = new Set<string>();
    for (const d of docs) for (const x of d.describes) if (x.confidence === 'exact') (x.isDir ? listedDirs : listedFiles).add(x.path);

    const all = rankKeyFiles(idx, 'new_dev', 100_000);
    const must = new Set(all.tiers.mustRead.map((i) => i.path));
    const next = new Set(all.tiers.readNext.map((i) => i.path));
    const pool = new Set(candidateFiles(idx, 'new_dev').map((f) => f.path));
    const scored = [...listedFiles].filter((f) => pool.has(f));
    const dirs = [...listedDirs].filter((d) => d !== '.');
    const dirHit = dirs.filter((d) => [...must].some((p) => p.startsWith(`${d}/`)));

    const row = {
      docsUsed: docs.map((d) => d.path),
      filesListedByMaintainers: listedFiles.size,
      listedFilesThatAreCandidates: scored.length,
      foldersListed: dirs.length,
      mustReadSize: must.size,
      candidateFiles: pool.size,
      scoredOk: scored.length >= 3,
      overlapMustRead: scored.length >= 3 ? scored.filter((f) => must.has(f)).length / scored.length : null,
      overlapMustOrReadNext: scored.length >= 3 ? scored.filter((f) => must.has(f) || next.has(f)).length / scored.length : null,
      expectedByChanceMustRead: pool.size ? must.size / pool.size : null,
      foldersWithAMustReadFile: dirs.length >= 3 ? dirHit.length / dirs.length : null,
      listedFilesMissedByMustRead: scored.filter((f) => !must.has(f)).slice(0, 10),
    };
    (out.repos as Record<string, unknown>)[demo.repo] = row;
    console.log(`\n${demo.repo} (tier ${demo.snap.tier})`);
    console.log(`  docs: ${row.docsUsed.join(', ') || 'none'}`);
    console.log(`  files named by maintainers: ${row.filesListedByMaintainers} (${row.listedFilesThatAreCandidates} are rankable code/config), folders named: ${row.foldersListed}`);
    if (row.scoredOk) {
      console.log(`  Must read overlap: ${pct(row.overlapMustRead!)}  Must or Read next: ${pct(row.overlapMustOrReadNext!)}  (chance level for Must read: ${pct(row.expectedByChanceMustRead!)})`);
      if (row.foldersWithAMustReadFile !== null) console.log(`  folders with a Must read file: ${pct(row.foldersWithAMustReadFile)}`);
      console.log(`  named but not in Must read: ${row.listedFilesMissedByMustRead.join(', ') || 'none'}`);
    } else {
      console.log('  NOT SCORABLE: the maintainers\' docs name fewer than 3 rankable files, so no overlap number is reported.');
    }
  }
  await fs.mkdir('docs/eval', { recursive: true });
  await fs.writeFile('docs/eval/keyfiles.json', JSON.stringify(out, null, 2) + '\n');
  console.log('\nWrote docs/eval/keyfiles.json');
}

main().then(() => process.exit(0), (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
