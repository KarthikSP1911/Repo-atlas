/**
 * Loads every file in SNAPSHOT_DIR through the same StoreService the server uses and prints a
 * one-screen summary. Exits 1 if any file was rejected, so it can gate a deploy.
 *
 *   npm run check-snapshots [-- <dir>]
 */
import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StoreService } from '../src/services/store.service.js';
import { IssuesFileSchema } from '../src/services/issues.schema.js';
import { BEGINNER_LABEL } from '../src/services/link.service.js';

async function main(): Promise<void> {
  const store = new StoreService();
  if (process.argv[2]) store.dir = process.argv[2];

  const problems = await store.problems();
  const infos = await store.list();
  let bad = problems.length;
  for (const p of problems) console.error(`REJECTED ${p.file}: ${p.reason}`);
  if (infos.length === 0) {
    console.error(`No snapshots found in ${store.dir}`);
    process.exit(1);
  }

  for (const info of infos) {
    const s = await store.summary(info.id);
    const n = s.counts.nodes;
    const e = s.counts.edges;
    const size = fs.statSync(path.resolve(store.dir, `${info.file}.json`)).size;
    console.log(`\n${s.id}  tier ${s.tier}  truncated ${s.truncated}  window ${s.commitWindow}  ${(size / 1024).toFixed(0)} KB`);
    console.log(`  nodes: file ${n.file}, dir ${n.dir}, commit ${n.commit}, pr ${n.pr}, issue ${n.issue}, person ${n.person}, doc ${n.doc}, entry ${n.entry}`);
    console.log(`  edges: imports ${e.imports}, touches ${e.touches}, fixes ${e.fixes}, describes ${e.describes}, reviewed ${e.reviewed}`);
    console.log(`  languages ${JSON.stringify(s.languages)}  entry points ${JSON.stringify(s.entryPoints.slice(0, 4))}`);

    const issuesFile = path.resolve(store.dir, `${info.file}.issues.json`);
    if (!fs.existsSync(issuesFile)) {
      console.log('  issues file: none');
      continue;
    }
    const parsed = IssuesFileSchema.safeParse(JSON.parse(fs.readFileSync(issuesFile, 'utf8')));
    if (!parsed.success) {
      console.error(`  REJECTED ${info.file}.issues.json: ${parsed.error.issues[0]?.message}`);
      bad++;
      continue;
    }
    const iss = parsed.data;
    const beginner = iss.issues.filter((i) => i.labels.some((l) => BEGINNER_LABEL.test(l))).length;
    console.log(`  issues: ${iss.issues.length} open, ${beginner} beginner-labelled, ${iss.issues.filter((i) => i.assignees.length).length} assigned, ${iss.issues.filter((i) => i.linkedPrs.length).length} with a linked PR; fetched ${iss.fetchedAt}`);
  }
  console.log(`\n${infos.length} snapshot(s) OK${bad ? `, ${bad} problem(s)` : ''}.`);
  // Exit explicitly: importing @nitrostack/core leaves a handle open that would keep the process alive.
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
