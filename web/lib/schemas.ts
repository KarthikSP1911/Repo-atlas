import { z } from 'zod';

/**
 * Zod schemas for the website, in two groups.
 *
 * 1. INPUT schemas: what a person types into the demo and the tool explorer. They give friendly
 *    messages before anything is sent, and they mirror the server's own tool schemas (a test
 *    in tests/web-schemas.test.ts checks that what they produce is accepted by the real tools).
 * 2. RESPONSE schemas: the few fields the page itself depends on (a snapshot id, a confirm
 *    token, a list of entry points). The server is a separate program and its answers are
 *    untrusted data, so they are checked before use. They are "loose": extra fields pass through.
 */

// ---------------------------------------------------------------------------------------------
// Repo references (same rules as src/services/live/repo-spec.ts on the server)
// ---------------------------------------------------------------------------------------------

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

function accept(owner: string, name: string): string | null {
  const n = name.replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner) || owner.endsWith('-') || owner.includes('--')) return null;
  if (!NAME_RE.test(n) || n === '.' || n === '..') return null;
  return `${owner}/${n}`;
}

/** `owner/repo` from owner/repo, owner__repo, a github.com URL or a git@github.com address; null otherwise. */
export function parseGithubRepo(input: string): string | null {
  let s = (input ?? '').trim();
  if (!s || s.length > 300 || /[\s\u0000-\u001f]/.test(s)) return null;
  const ssh = /^(?:ssh:\/\/)?git@([^/:]+)[:/](.+)$/i.exec(s);
  if (ssh) {
    if (ssh[1].toLowerCase() !== 'github.com') return null;
    s = ssh[2];
  } else {
    const url = /^(?:https?:\/\/)?(?:www\.)?([^/@?#]+)\/(.*)$/i.exec(s);
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

/** The four ready-made repos can be given by their short name. */
export const PRESET_REPOS = ['tsoa', 'pwndbg', 'go-git', 'sample'] as const;
const SNAPSHOT_ID_RE = /^[A-Za-z0-9-]+__[A-Za-z0-9._-]+@[0-9a-f]{7}$/;

export const REPO_HELP = 'Use a GitHub link such as https://github.com/pallets/click, or owner/repo such as pallets/click. Only public repos work.';

export const repoSchema = z
  .string()
  .trim()
  .min(1, 'Enter a repo first. ' + REPO_HELP)
  .max(300, 'That is too long to be a repo link.')
  .refine((v) => (PRESET_REPOS as readonly string[]).includes(v) || SNAPSHOT_ID_RE.test(v) || parseGithubRepo(v) !== null, { message: `That does not look like a GitHub repo. ${REPO_HELP}` });

/** The MCP server address the page talks to. */
export const endpointSchema = z
  .string()
  .trim()
  .url('Enter a full address such as https://your-app.app.nitrocloud.ai/mcp')
  .refine((v) => /^https?:\/\//i.test(v), { message: 'Only http and https addresses are allowed.' });

// ---------------------------------------------------------------------------------------------
// Tool inputs (what people type), turned into the arguments the server expects
// ---------------------------------------------------------------------------------------------

export const ROLE_VALUES = ['new_dev', 'reviewer', 'tester', 'quick_look'] as const;
export const LEVEL_VALUES = ['beginner', 'intermediate', 'advanced'] as const;

const roleSchema = z.enum(ROLE_VALUES, { errorMap: () => ({ message: 'Choose one of the four roles.' }) });
const levelSchema = z.enum(LEVEL_VALUES, { errorMap: () => ({ message: 'Choose Beginner, Intermediate or Advanced.' }) });

/** A whole number in a range, or blank (meaning "use the default"). */
const optionalInt = (label: string, min: number, max: number) =>
  z.string().transform((raw, ctx): number | undefined => {
    const v = raw.trim();
    if (v === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      ctx.addIssue({ code: 'custom', message: `${label} must be a whole number from ${min} to ${max}.` });
      return z.NEVER;
    }
    return n;
  });

/** A whole number in a range that must be given. */
const requiredInt = (label: string, min: number, max: number) =>
  z.string().transform((raw, ctx): number => {
    const v = raw.trim();
    const n = Number(v);
    if (v === '' || !Number.isInteger(n) || n < min || n > max) {
      ctx.addIssue({ code: 'custom', message: `${label} must be a whole number from ${min} to ${max}.` });
      return z.NEVER;
    }
    return n;
  });

/** A file path, or blank (meaning "pick one for me"). Paths in a repo use forward slashes. */
const optionalPath = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().max(300, 'That path is too long.').refine((v) => !/[\u0000-\u001f]/.test(v), { message: 'That path has unusual characters in it.' }));

const splitList = (raw: string): string[] =>
  raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const languages = z
  .string()
  .transform(splitList)
  .pipe(
    z
      .array(z.string().min(1).max(30, 'Each language must be 30 characters or fewer.'))
      .min(1, 'Enter at least one language, for example TypeScript. Separate several with commas.')
      .max(12, 'Enter at most 12 languages.'),
  );

const areas = z
  .string()
  .transform(splitList)
  .pipe(z.array(z.string().min(1).max(40, 'Each area must be 40 characters or fewer.')).max(10, 'Enter at most 10 areas.'));

const profileFields = { languages, level: levelSchema, areas };

/** One schema per tool, over the strings in the form. The output is what the tool-specific code needs. */
export const FORM_SCHEMAS = {
  build_graph: z.object({}),
  project_overview: z.object({}),
  find_entry_points: z.object({}),
  key_files: z.object({ role: roleSchema, limit: optionalInt('Files per group', 1, 50) }),
  trace_flow: z.object({ entry: optionalPath, depth: optionalInt('Import hops', 1, 6), maxFiles: optionalInt('Max files', 1, 40) }),
  explain_file: z.object({ path: optionalPath }),
  tour_next: z.object({ role: roleSchema, stage: requiredInt('Stage', 1, 8) }),
  profile_contributor: z.object(profileFields),
  find_candidate_issues: z.object({ ...profileFields, limit: optionalInt('How many issues', 1, 25) }),
  localize_issue: z.object({ issueNumber: optionalInt('Issue number', 1, 10_000_000) }),
  score_first_change: z.object({ issueNumber: optionalInt('Issue number', 1, 10_000_000), ...profileFields }),
  // The page handles the confirmation code itself; blank means "step 1: preview".
  export_guide: z.object({ confirmToken: z.string().default('').transform((v) => v.trim()).pipe(z.string().max(200, 'That code is too long.')) }),
} as const;

export type ToolName = keyof typeof FORM_SCHEMAS;

export type FormResult = { ok: true; data: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

/** Check the form's text values for one tool. On failure, one plain message per field. */
export function validateForm(tool: string, values: Record<string, string>): FormResult {
  const schema = (FORM_SCHEMAS as Record<string, z.ZodTypeAny>)[tool];
  if (!schema) return { ok: false, errors: { _form: `Unknown tool ${tool}.` } };
  const r = schema.safeParse(values);
  if (r.success) return { ok: true, data: r.data as Record<string, unknown> };
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = String(issue.path[0] ?? '_form');
    if (!errors[key]) errors[key] = issue.message;
  }
  return { ok: false, errors };
}

/** Values the explorer works out itself (a snapshot id, an auto-picked file or issue, a profile). */
export interface ToolArgExtra {
  repo?: string;
  snapshotId?: string;
  entry?: string;
  path?: string;
  issueNumber?: number;
  profile?: Record<string, unknown>;
}

/** The exact arguments to send to a tool, from the checked form data plus the values worked out around it. */
export function toolArgs(tool: string, d: Record<string, unknown>, x: ToolArgExtra): Record<string, unknown> {
  const num = (key: string): Record<string, number> => (typeof d[key] === 'number' ? { [key]: d[key] as number } : {});
  const snapshotId = x.snapshotId;
  switch (tool) {
    case 'build_graph':
      return { repo: x.repo };
    case 'project_overview':
    case 'find_entry_points':
      return { snapshotId };
    case 'key_files':
      return { snapshotId, role: d.role, ...num('limit') };
    case 'trace_flow':
      return { snapshotId, entry: x.entry ?? d.entry, ...num('depth'), ...num('maxFiles') };
    case 'explain_file':
      return { snapshotId, path: x.path ?? d.path };
    case 'tour_next':
      return { snapshotId, role: d.role, stage: d.stage };
    case 'profile_contributor': {
      const areas = (d.areas as string[] | undefined) ?? [];
      return { languages: d.languages, level: d.level, ...(areas.length ? { familiarAreas: areas } : {}) };
    }
    case 'find_candidate_issues':
      return { snapshotId, profile: x.profile, limit: typeof d.limit === 'number' ? d.limit : 10 };
    case 'localize_issue':
      return { snapshotId, issueNumber: x.issueNumber };
    case 'score_first_change':
      return { snapshotId, issueNumber: x.issueNumber, profile: x.profile };
    case 'export_guide':
      return { snapshotId, ...(d.confirmToken ? { confirmToken: d.confirmToken } : {}) };
    default:
      throw new Error(`Unknown tool ${tool}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Server answers the page reads (loose: unknown fields pass through)
// ---------------------------------------------------------------------------------------------

const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

export const buildGraphResponse = loose({
  status: z.enum(['ready', 'unavailable']),
  message: z.string().optional(),
  snapshotId: z.string().optional(),
  source: z.enum(['precomputed', 'built_on_demand']).optional(),
});
export const entryPointsResponse = loose({ entryPoints: z.array(loose({ path: z.string() })).default([]) });
export const profileResponse = loose({ profile: z.record(z.unknown()) });
export const candidatesResponse = loose({ candidates: z.array(loose({ number: z.number().int() })).default([]) });
export const exportPreviewResponse = loose({ confirmToken: z.string().optional() });
export const pingResponse = loose({ liveBuilds: z.boolean().optional(), exportSecretConfigured: z.boolean().optional(), githubTokenConfigured: z.boolean().optional() });

/** Parse a server answer, or throw an error whose message a person can act on. */
export function parseResponse<S extends z.ZodTypeAny>(schema: S, data: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data as z.infer<S>;
  const first = r.error.issues[0];
  const where = first?.path.length ? ` (${first.path.join('.')}: ${first.message})` : '';
  throw new Error(`${what} answered in a shape this page does not understand${where}. The server may be an incompatible version.`);
}
