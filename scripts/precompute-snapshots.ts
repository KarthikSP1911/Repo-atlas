/**
 * Offline snapshot builder. Run on a developer machine, never on NitroCloud (no git there).
 *
 *   npm run precompute -- owner/repo [owner/repo ...] [--window 1000] [--max-files 1500]
 *                         [--out data/snapshots] [--no-github] [--keep-clone]
 *
 * Writes <out>/<owner>__<repo>@<sha7>.json and <out>/<owner>__<repo>@<sha7>.issues.json.
 * GITHUB_TOKEN is read from .env (or the environment); it is never printed or stored.
 */
import 'dotenv/config';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSnapshot, type BuildReport } from '../src/services/build.service.js';
import { ApiBudget, makeGraphql, sanitizeError } from '../src/services/link.service.js';
import { normalizeRepoRef } from '../src/services/snapshot.schema.js';

interface Args {
  repos: string[];
  window: number;
  maxFiles: number;
  out: string;
  github: boolean;
  keepClone: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { repos: [], window: 1000, maxFiles: 1500, out: 'data/snapshots', github: true, keepClone: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--window') a.window = Number(argv[++i]);
    else if (v === '--max-files') a.maxFiles = Number(argv[++i]);
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--no-github') a.github = false;
    else if (v === '--keep-clone') a.keepClone = true;
    else if (v.startsWith('--')) throw new Error(`Unknown option ${v}`);
    else {
      const repo = normalizeRepoRef(v);
      if (!repo) throw new Error(`"${v}" is not an owner/repo or GitHub URL`);
      a.repos.push(repo);
    }
  }
  if (a.repos.length === 0) throw new Error('Usage: npm run precompute -- owner/repo [owner/repo ...]');
  if (!Number.isInteger(a.window) || a.window < 1) throw new Error('--window must be a positive integer');
  if (!Number.isInteger(a.maxFiles) || a.maxFiles < 1) throw new Error('--max-files must be a positive integer');
  return a;
}

function printReport(r: BuildReport): void {
  const skipped = Object.entries(r.files.skipped).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
  console.log(`\n=== ${r.snapshotId} ===`);
  console.log(`tier ${r.tier}, truncated ${r.truncated}, ${r.nodes} nodes, ${r.edges} edges, ${(r.bytes / 1024).toFixed(0)} KB`);
  console.log(`files: ${r.files.kept} kept of ${r.files.tracked} tracked (skipped: ${skipped})`);
  console.log(`parse: ${r.parse.jsTsFiles} JS/TS, ${r.parse.pyFiles} Python, ${r.parse.importEdges} import edges, ${r.parse.parseErrors} errors`);
  console.log(`history: ${r.commitsRead} commits read, ${r.commitNodes} commit nodes; PRs ${r.prs}; open issues ${r.openIssues}`);
  console.log(`github: ${r.api.calls}/${r.api.maxCalls} calls, cost ${r.api.cost}, remaining ${r.api.remaining ?? 'n/a'}${r.api.stoppedReason ? `, STOPPED: ${r.api.stoppedReason}` : ''}`);
  for (const l of r.api.log) console.log(`  - ${l.name}: cost ${l.cost}, remaining ${l.remaining}`);
  console.log(`timings ms: ${Object.entries(r.timingsMs).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  for (const w of r.warnings) console.log(`warning: ${w}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN?.trim() ?? '';
  const useGithub = args.github && token.length > 0;
  if (args.github && !useGithub) console.warn('GITHUB_TOKEN is not set in .env: building without PRs and issues. Use --no-github to silence this.');
  const graphql = useGithub ? makeGraphql(token) : null;

  const outDir = path.resolve(process.cwd(), args.out);
  await fs.mkdir(outDir, { recursive: true });
  const reports: BuildReport[] = [];

  for (const repo of args.repos) {
    const workDir = path.join(os.tmpdir(), 'repoatlas-clones', `${repo.replace('/', '__')}-${Date.now()}`);
    try {
      const result = await buildSnapshot({
        repo,
        workDir,
        commitWindow: args.window,
        maxFiles: args.maxFiles,
        graphql,
        budget: new ApiBudget(30),
        log: (m) => console.log(`[${repo}] ${m}`),
      });
      await fs.writeFile(path.join(outDir, `${result.id}.json`), JSON.stringify(result.snapshot));
      await fs.writeFile(path.join(outDir, `${result.id}.issues.json`), JSON.stringify(result.issues));
      printReport(result.report);
      reports.push(result.report);
    } catch (e) {
      console.error(`[${repo}] FAILED: ${sanitizeError(e, [token])}`);
      process.exitCode = 1;
    } finally {
      if (!args.keepClone) await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const totalCalls = reports.reduce((n, r) => n + r.api.calls, 0);
  console.log(`\nDone: ${reports.length}/${args.repos.length} snapshots written to ${args.out}; ${totalCalls} GitHub calls in total.`);
}

main().catch((e) => {
  console.error(sanitizeError(e, [process.env.GITHUB_TOKEN ?? '']));
  process.exit(1);
});
