/**
 * Reads "which GitHub repo" out of whatever the user typed. Strict on purpose: the result is used
 * to build a download URL, so only a plain `owner` and `name` may come out, and only for github.com.
 */

export interface RepoSpec {
  owner: string;
  name: string;
  /** `owner/name`, as typed. */
  repo: string;
}

/** GitHub user and org names: letters, digits and single hyphens, at most 39 characters. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

function accept(owner: string, name: string): RepoSpec | null {
  const n = name.replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner) || owner.endsWith('-') || owner.includes('--')) return null;
  if (!NAME_RE.test(n) || n === '.' || n === '..') return null;
  return { owner, name: n, repo: `${owner}/${n}` };
}

/**
 * Accepts `owner/repo`, `owner__repo`, `github.com/owner/repo`, `https://github.com/owner/repo`
 * (with `www.`, `.git`, a trailing path such as `/tree/main`, a query or a fragment),
 * `git@github.com:owner/repo.git` and `ssh://git@github.com/owner/repo`. Anything on another
 * host, or anything that is not a plain owner and name, returns null.
 */
export function parseRepoSpec(input: string): RepoSpec | null {
  let s = (input ?? '').trim();
  if (!s || s.length > 300 || /[\s\u0000-\u001f]/.test(s)) return null;

  const ssh = /^(?:ssh:\/\/)?git@([^/:]+)[:/](.+)$/i.exec(s);
  if (ssh) {
    if (ssh[1].toLowerCase() !== 'github.com') return null;
    s = ssh[2];
  } else {
    const url = /^(?:https?:\/\/)?(?:www\.)?([^/@?#]+)\/(.*)$/i.exec(s);
    // A first segment with a dot is a host ("github.com", "gitlab.com"); owners never contain dots.
    if (url && url[1].includes('.')) {
      if (url[1].toLowerCase() !== 'github.com') return null;
      s = url[2];
    } else if (/^https?:\/\//i.test(s)) {
      return null;
    }
  }
  s = s.split(/[?#]/)[0].replace(/\/+$/, '');

  const slash = /^([^/]+)\/([^/]+)(?:\/.*)?$/.exec(s);
  if (slash) return accept(slash[1], slash[2]);
  const underscore = /^([A-Za-z0-9-]+)__([A-Za-z0-9._-]+)$/.exec(s);
  return underscore ? accept(underscore[1], underscore[2]) : null;
}
