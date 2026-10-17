/** Small helpers for the live demo. Everything from the server is untrusted: read it defensively. */

export type Rec = Record<string, unknown>;

export function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export const asRec = (v: unknown): Rec => (isRec(v) ? v : {});
export const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const strList = (v: unknown): string[] => asArr(v).filter((x): x is string => typeof x === 'string');
export const recList = (v: unknown): Rec[] => asArr(v).filter(isRec);

/** Only GitHub links become clickable; anything else is shown as plain text. */
export function safeGithubUrl(u: unknown): string | null {
  return typeof u === 'string' && u.startsWith('https://github.com/') ? u : null;
}

export const RAW_CLIP = 20_000;

export function prettyJson(v: unknown, max: number = RAW_CLIP): { text: string; clipped: boolean; total: number } {
  let text: string;
  try {
    text = JSON.stringify(v, null, 2) ?? 'undefined';
  } catch {
    text = String(v);
  }
  return text.length > max ? { text: text.slice(0, max), clipped: true, total: text.length } : { text, clipped: false, total: text.length };
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A string that looks like a repo file path (no spaces, has a slash or a short extension). */
export function looksLikePath(s: string): boolean {
  if (s.length === 0 || s.length > 200 || /\s/.test(s)) return false;
  if (/^[a-z]+:\/\//i.test(s)) return false;
  return s.includes('/') ? /[A-Za-z0-9_.-]$/.test(s) && !s.endsWith('/') : /^[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}$/.test(s);
}

export function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return spaced.length === 0 ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function fmtDate(iso: unknown): string {
  const s = str(iso);
  if (s === '') return 'unknown';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function shortArgs(args: Record<string, unknown>, max = 70): string {
  const parts = Object.entries(args).map(([k, v]) => {
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}=${clip(val ?? '', 24)}`;
  });
  return clip(parts.join(', '), max);
}

/** export_guide's answer when the server has no signing secret. */
export const looksLikeMissingSecret = (message: string): boolean => /EXPORT_SECRET must be set/i.test(message);

export const MISSING_SECRET_HINT =
  'The server you are connected to (the MCP server box above) has no EXPORT_SECRET. A .env file only applies to a server running on your own machine and is never uploaded. For the NitroCloud URL, add EXPORT_SECRET (16 or more characters) in the environment variables of the MCP in the NitroCloud dashboard, then redeploy. Check with ping_repoatlas: exportSecretConfigured must be true.';

/** What the old (snapshot-only) server build says when asked for a repo it does not have. */
export const looksLikeOldBuild = (message: string): boolean => /snapshot mode|cannot clone or build repos on demand|only serves repos precomputed/i.test(message);

export const OLD_BUILD_HINT =
  'This server can only open its four precomputed repos (it is an older RepoAtlas build, or LIVE_BUILDS=off). The latest code builds any public GitHub repo: redeploy it (npm run deploy:pack, then upload repoatlas.zip in NitroCloud), or use a local server that runs the latest code.';

/** Value of the repo picker's "another repo" option; the text box holds the URL. */
export const CUSTOM_REPO = '__custom';

/** What to pass to build_graph for the picker's state. */
export const repoArgOf = (value: string, custom: string): string => (value === CUSTOM_REPO ? custom.trim() : value);

export const REPOS = [
  { value: 'tsoa', label: 'tsoa (TypeScript, tier 2)' },
  { value: 'pwndbg', label: 'pwndbg (Python, tier 2)' },
  { value: 'go-git', label: 'go-git (Go, tier 1)' },
  { value: 'sample', label: 'sample (tiny demo shop)' },
] as const;

export const ROLES = [
  { value: 'new_dev', label: 'New developer' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'tester', label: 'Tester' },
  { value: 'quick_look', label: 'Quick look' },
] as const;

export const LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export const LANGUAGES = ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java'] as const;

export const TIER_MEANING: Record<number, string> = {
  1: 'Tier 1: file tree, history and people only. There is no import graph, so import-based results are empty.',
  2: 'Tier 2: includes an import graph for JavaScript, TypeScript and Python files.',
};
