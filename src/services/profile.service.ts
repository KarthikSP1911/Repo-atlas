import { LEVELS, type Level, type Profile, type ProfileResult } from './profile.types.js';
import { fetchGraphql, type GraphqlFn } from './github.graphql.js';

/**
 * Builds a contributor profile from what the person states, and optionally from the public
 * languages on their GitHub account. The GitHub read is one GraphQL query and happens only in
 * live mode with a token; on the deployed snapshot-mode server nothing is read and the result
 * says so. Only public data is ever requested.
 */

/** Names people use, mapped to the language ids snapshots use (file meta `lang`). */
const ALIASES: Record<string, string> = {
  typescript: 'ts', ts: 'ts', tsx: 'ts',
  javascript: 'js', js: 'js', node: 'js', nodejs: 'js', 'node.js': 'js', jsx: 'js', react: 'js',
  python: 'py', py: 'py', python3: 'py',
  go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust',
  java: 'java', kotlin: 'kotlin', kt: 'kotlin', scala: 'scala',
  ruby: 'ruby', rb: 'ruby', php: 'php',
  c: 'c', 'c++': 'cpp', cpp: 'cpp', cxx: 'cpp', 'c#': 'csharp', csharp: 'csharp', dotnet: 'csharp',
  swift: 'swift', dart: 'dart', lua: 'lua', perl: 'perl', elixir: 'elixir', zig: 'zig', r: 'r',
  shell: 'shell', bash: 'shell', sh: 'shell', html: 'html', css: 'css', sql: 'sql',
  assembly: 'asm', asm: 'asm', vue: 'vue', svelte: 'svelte',
};

export function normalizeLanguage(input: string): string | null {
  return ALIASES[input.trim().toLowerCase()] ?? null;
}

export function normalizeLanguages(inputs: string[]): { languages: string[]; unknown: string[] } {
  const languages: string[] = [];
  const unknown: string[] = [];
  for (const raw of inputs) {
    const id = normalizeLanguage(raw);
    if (id) {
      if (!languages.includes(id)) languages.push(id);
    } else if (raw.trim()) {
      unknown.push(raw.trim().slice(0, 30));
    }
  }
  return { languages, unknown };
}

const USER_LANGS_QUERY = `
query($login:String!){
  user(login:$login){
    repositories(first:30, ownerAffiliations:OWNER, isFork:false, orderBy:{field:PUSHED_AT,direction:DESC}){
      nodes{ primaryLanguage{ name } }
    }
  }
}`;

/** One query: the primary languages of the user's 30 most recently pushed public repos, most common first. */
export async function readGithubLanguages(username: string, gql: GraphqlFn): Promise<string[]> {
  const res = await gql(USER_LANGS_QUERY, { login: username });
  const nodes: { primaryLanguage: { name: string } | null }[] = res?.user?.repositories?.nodes ?? [];
  const counts = new Map<string, number>();
  for (const n of nodes) if (n.primaryLanguage?.name) counts.set(n.primaryLanguage.name, (counts.get(n.primaryLanguage.name) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name).slice(0, 5);
}

const AREA_ALIASES: Record<string, string> = {
  api: 'api', backend: 'api', server: 'api', routes: 'api', rest: 'api',
  test: 'tests', tests: 'tests', testing: 'tests', qa: 'tests',
  doc: 'docs', docs: 'docs', documentation: 'docs', writing: 'docs',
  ui: 'ui', frontend: 'ui', front: 'ui', css: 'ui', web: 'ui',
  db: 'database', database: 'database', sql: 'database', data: 'database',
  cli: 'cli', tooling: 'cli', scripts: 'cli', build: 'build', ci: 'build', devops: 'build',
};

export function normalizeAreas(inputs: string[]): string[] {
  return [...new Set(inputs.map((a) => AREA_ALIASES[a.trim().toLowerCase()] ?? a.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

export interface ProfileInput {
  languages: string[];
  level: Level;
  familiarAreas?: string[];
  username?: string;
}

export interface GithubAccess {
  /** True only in live mode with a token configured. */
  enabled: boolean;
  gql?: GraphqlFn;
}

/** Reads the environment once per call; tests pass `access` explicitly. */
export function githubAccessFromEnv(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): GithubAccess {
  const token = env.GITHUB_TOKEN?.trim();
  if (env.RUNTIME_MODE === 'live' && token) return { enabled: true, gql: fetchGraphql(token, fetchFn) };
  return { enabled: false };
}

export async function buildProfile(input: ProfileInput, access: GithubAccess = { enabled: false }): Promise<ProfileResult> {
  if (!LEVELS.includes(input.level)) throw new Error(`level must be one of ${LEVELS.join(', ')}`);
  const stated = normalizeLanguages(input.languages);
  const readNotes: string[] = [`Stated by you: languages ${stated.languages.join(', ') || 'none recognised'}, level ${input.level}.`];
  if (stated.unknown.length) readNotes.push(`Not recognised as languages RepoAtlas can match: ${stated.unknown.join(', ')}.`);

  const languages = [...stated.languages];
  let githubCalls = 0;
  const username = input.username?.trim().replace(/^@/, '');
  if (username) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(username)) {
      readNotes.push('The GitHub username was not valid, so nothing was read from GitHub.');
    } else if (!access.enabled || !access.gql) {
      readNotes.push(`Nothing was read from GitHub for @${username}: this server runs in snapshot mode and makes no runtime GitHub calls. The username is kept on the profile only.`);
    } else {
      try {
        githubCalls = 1;
        const found = normalizeLanguages(await readGithubLanguages(username, access.gql));
        for (const l of found.languages) if (!languages.includes(l)) languages.push(l);
        readNotes.push(`Read the primary languages of @${username}'s 30 most recent public non-fork repositories (1 GraphQL call): ${found.languages.join(', ') || 'none found'}. No other data was read.`);
      } catch {
        readNotes.push(`Reading public languages for @${username} failed; continuing with what you stated.`);
      }
    }
  }
  if (languages.length === 0) readNotes.push('No language was recognised, so language fit will not be able to rank issues.');

  const profile: Profile = {
    languages: languages.slice(0, 12),
    level: input.level,
    familiarAreas: normalizeAreas(input.familiarAreas ?? []),
    ...(username ? { username } : {}),
  };
  return { profile, readNotes, githubCalls };
}
