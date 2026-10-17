import { simpleGit, type SimpleGit } from 'simple-git';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_COMMIT_WINDOW, DEFAULT_MAX_FILES, LOCKFILES, MAX_FILE_BYTES, keepPriority, skipReason, type IngestFile, type IngestResult } from './ingest.common.js';

export * from './ingest.common.js';

/**
 * OFFLINE ONLY (precompute script, tests). Needs the `git` binary, which NitroCloud does not
 * have (docs/SPIKE.md). Nothing in the deployed server imports this file.
 */

/**
 * Environment for git child processes: the parent environment minus variables that can make git
 * run other programs (editors, pagers, askpass helpers, ssh commands). simple-git refuses to run
 * with some of these set, and a repo being analysed must never be able to influence them.
 */
export function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(EDITOR|VISUAL|PAGER|GIT_.*|SSH_.*|LESS.*)$/i.test(k)) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** The only git client used offline: sanitized env, with just GIT_TERMINAL_PROMPT=0 allowed through. */
export function gitClient(baseDir: string): SimpleGit {
  return simpleGit({ baseDir, allowEnvironment: ['GIT_TERMINAL_PROMPT'] }).env(gitEnv());
}

export function cloneUrlFor(repo: string): string {
  return `https://github.com/${repo}.git`;
}

export interface IngestOptions {
  repo: string;
  /** Empty directory the clone is created in (created if missing). */
  dir: string;
  /** Defaults to https://github.com/<repo>.git. Tests pass a file:// URL. */
  cloneUrl?: string;
  commitWindow?: number;
  maxFiles?: number;
}

export async function ingestRepo(opts: IngestOptions): Promise<IngestResult> {
  const window = opts.commitWindow ?? DEFAULT_COMMIT_WINDOW;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const url = opts.cloneUrl ?? cloneUrlFor(opts.repo);

  await fs.mkdir(path.dirname(opts.dir), { recursive: true });
  const t0 = Date.now();
  // Public repos only, so no credentials are passed to git (nothing to leak into .git/config).
  await gitClient(path.dirname(opts.dir))
    .clone(url, opts.dir, ['--depth', String(window), '--filter=blob:none', '--single-branch']);
  const cloneMs = Date.now() - t0;

  const git = gitClient(opts.dir);
  const sha = (await git.revparse(['HEAD'])).trim();
  const defaultBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  const commitCount = Number((await git.raw(['rev-list', '--count', 'HEAD'])).trim());
  const tracked = (await git.raw(['-c', 'core.quotepath=false', 'ls-files', '-z'])).split('\0').filter(Boolean);

  const skipped: Record<string, number> = {};
  const lockfiles: string[] = [];
  const candidates: IngestFile[] = [];
  for (const p of tracked) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (LOCKFILES.has(base) && !lockfiles.includes(base)) lockfiles.push(base);
    const reason = skipReason(p);
    if (reason) {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      continue;
    }
    let size = 0;
    try {
      size = (await fs.stat(path.join(opts.dir, p))).size;
    } catch {
      skipped['missing'] = (skipped['missing'] ?? 0) + 1; // submodule or symlink target
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      skipped['too-large'] = (skipped['too-large'] ?? 0) + 1;
      continue;
    }
    candidates.push({ path: p, size });
  }

  let files = candidates;
  let truncated = false;
  if (candidates.length > maxFiles) {
    truncated = true;
    files = [...candidates]
      .sort((a, b) => keepPriority(a.path) - keepPriority(b.path) || a.path.localeCompare(b.path))
      .slice(0, maxFiles);
    skipped['over-file-cap'] = candidates.length - maxFiles;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  return { repo: opts.repo, sha, defaultBranch, dir: opts.dir, files, totalTracked: tracked.length, skipped, truncated, commitCount, lockfiles, cloneMs };
}
