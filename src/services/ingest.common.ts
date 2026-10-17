/**
 * Pure file-filtering rules shared by the offline ingest (git checkout) and the live on-demand
 * build (GitHub tarball). No heavy imports: the deployed server loads this file.
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

export const LOCKFILES = new Set([
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

