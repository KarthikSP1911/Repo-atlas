import { simpleGit, type SimpleGit } from 'simple-git';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * OFFLINE ONLY (precompute script, tests). Needs the `git` binary, which NitroCloud does not
 * have (docs/SPIKE.md). Nothing in the deployed server imports this file.
 */

export const DEFAULT_COMMIT_WINDOW = 1000;
export const DEFAULT_MAX_FILES = 1500;
/** Files above this size are skipped (almost always generated or data). */
export const MAX_FILE_BYTES = 1024 * 1024;

export interface IngestFile {
  /** Repo-relative path with forward slashes. */
  path: string;
  size: number;
}

export interface IngestResult {
  repo: string;
  sha: string;
  defaultBranch: string;
  dir: string;
  files: IngestFile[];
  /** Tracked files before filtering and capping. */
  totalTracked: number;
  /** Counts of files dropped by each filter reason, for the build report. */
  skipped: Record<string, number>;
  truncated: boolean;
  /** Commits available in the shallow clone (at most the requested window). */
  commitCount: number;
  /** Names of lockfiles seen before filtering (package manager hints). */
  lockfiles: string[];
  cloneMs: number;
}

const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'third_party', 'bower_components', 'dist', 'build', 'out', '.next', '.nuxt',
  'target', 'coverage', '__pycache__', '.git', '.venv', 'venv', '.tox', '.idea', '.vscode',
  '__snapshots__', '__fixtures__', 'fixtures', 'testdata', '.yarn', '.pnpm-store',
]);

const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'poetry.lock', 'uv.lock',
  'Pipfile.lock', 'Cargo.lock', 'go.sum', 'composer.lock', 'Gemfile.lock', 'mix.lock',
]);

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'icns', 'webp', 'avif', 'bmp', 'tiff', 'svg', 'pdf', 'zip', 'gz', 'tgz', 'tar',
  'bz2', 'xz', '7z', 'rar', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'ogg',
  'wasm', 'exe', 'dll', 'so', 'dylib', 'a', 'o', 'class', 'jar', 'war', 'pyc', 'pyo', 'bin', 'dat', 'db', 'sqlite',
  'map', 'snap', 'psd', 'ai', 'sketch', 'DS_Store',
]);

const GENERATED_RE = /(\.min\.(js|css)$|\.generated\.|\.gen\.|\.pb\.go$|_pb2(_grpc)?\.py$|\.pb\.(js|ts)$|(^|\/)(generated|__generated__)\/)/i;

/** Returns the reason a path is dropped, or null if it should be kept. */
export function skipReason(p: string): string | null {
  const parts = p.split('/');
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((seg) => SKIP_DIRS.has(seg))) return 'ignored-dir';
  if (LOCKFILES.has(base)) return 'lockfile';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (ext && BINARY_EXT.has(ext)) return 'binary';
  if (GENERATED_RE.test(p)) return 'generated';
  return null;
}

const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'scala']);

/** Lower is kept first when the file cap is applied: shallow, code, non-test paths win. */
export function keepPriority(p: string): number {
  const parts = p.split('/');
  const base = parts[parts.length - 1];
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  let score = (parts.length - 1) * 10;
  if (!CODE_EXT.has(ext)) score += 5;
  if (/(^|\/)(tests?|__tests__|spec|e2e|examples?|docs?|benchmarks?)(\/|$)/i.test(p)) score += 12;
  return score;
}

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
