import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as core from '@nitrostack/core';
import { GraphTools } from '../src/modules/graph/graph.tools.js';
import { AnalysisTools } from '../src/modules/graph/analysis.tools.js';
import { ContributeTools } from '../src/modules/contribute/contribute.tools.js';
import { LocalizeTools } from '../src/modules/contribute/localize.tools.js';
import { TourTools } from '../src/modules/tour/tour.tools.js';
import { ActionsTools } from '../src/modules/actions/actions.tools.js';
import { parseRepoSpec } from '../src/services/live/repo-spec.js';
import {
  FORM_SCHEMAS,
  buildGraphResponse,
  candidatesResponse,
  endpointSchema,
  parseGithubRepo,
  parseResponse,
  repoSchema,
  toolArgs,
  validateForm,
} from '../web/lib/schemas.js';
import { GLOSSARY, GROUPS, TOOL_SPECS } from '../web/lib/tool-specs.js';

/**
 * The website validates what people type with zod before calling the server. These tests keep that
 * validation honest: it accepts and rejects the same repo references as the server, and the
 * arguments it builds are accepted by the server's own tool schemas, so the two cannot drift apart.
 */

type ToolMeta = { options: { name: string; inputSchema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: unknown[]; message: string }[] } } }; examples?: { request?: Record<string, unknown> } } };
const extractTools = (core as unknown as { extractTools: (c: unknown) => ToolMeta[] }).extractTools;
const serverTools = [GraphTools, AnalysisTools, ContributeTools, LocalizeTools, TourTools, ActionsTools].flatMap((c) => extractTools(c));
const serverTool = (name: string): ToolMeta => serverTools.find((t) => t.options.name === name)!;

describe('repo references: the website parses them exactly like the server', () => {
  const inputs = [
    'owner/repo',
    '  facebook/react  ',
    'lukeautry__tsoa',
    'https://github.com/vercel/next.js',
    'http://github.com/vercel/next.js/',
    'https://www.github.com/a-b/c_d.e',
    'github.com/pallets/flask',
    'https://github.com/pallets/flask.git',
    'https://github.com/pallets/flask/tree/main/src/flask?plain=1#L10',
    'git@github.com:rust-lang/rust.git',
    'ssh://git@github.com/rust-lang/rust',
    '',
    'react',
    'https://gitlab.com/a/b',
    'https://github.com.evil.example/a/b',
    'file:///etc/passwd',
    '../etc/passwd',
    'a/..',
    '-a/b',
    'a--b/c',
    'a b/c',
    'a/b;rm -rf /',
    'a/b\u0000',
    `${'a'.repeat(40)}/repo`,
    `owner/${'r'.repeat(101)}`,
    'x'.repeat(400),
  ];
  it.each(inputs)('%j', (input) => {
    expect(parseGithubRepo(input)).toBe(parseRepoSpec(input)?.repo ?? null);
  });
});

describe('repoSchema', () => {
  it.each(['tsoa', 'pwndbg', 'go-git', 'sample', 'lukeautry__tsoa@f0f9aa7', 'https://github.com/KarthikSP1911/math-trainer', 'pallets/click'])('accepts %s', (v) => {
    expect(repoSchema.safeParse(v).success).toBe(true);
  });
  it('trims and explains what is wrong in plain words', () => {
    expect(repoSchema.parse('  pallets/click  ')).toBe('pallets/click');
    const empty = repoSchema.safeParse('   ');
    expect(empty.success ? '' : empty.error.issues[0].message).toMatch(/Enter a repo first/);
    const bad = repoSchema.safeParse('https://gitlab.com/a/b');
    expect(bad.success ? '' : bad.error.issues[0].message).toMatch(/does not look like a GitHub repo.*public/);
  });
});

describe('endpointSchema', () => {
  it('accepts http and https addresses only', () => {
    expect(endpointSchema.safeParse(' https://app.example.com/mcp ').success).toBe(true);
    expect(endpointSchema.safeParse('http://localhost:3000/mcp').success).toBe(true);
    for (const bad of ['', 'localhost:3000', 'ftp://x/mcp', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url']) expect(endpointSchema.safeParse(bad).success, bad).toBe(false);
  });
});

describe('form validation gives one plain message per field', () => {
  it('accepts every tool with its default values and with its examples', () => {
    for (const spec of TOOL_SPECS) {
      const defaults = Object.fromEntries(spec.fields.map((f) => [f.name, f.default]));
      const examples = { ...defaults, ...Object.fromEntries(spec.fields.filter((f) => f.example).map((f) => [f.name, f.example!])) };
      expect(validateForm(spec.name, defaults), `${spec.name} defaults`).toMatchObject({ ok: true });
      expect(validateForm(spec.name, examples), `${spec.name} examples`).toMatchObject({ ok: true });
    }
  });

  it('explains stage mistakes', () => {
    for (const bad of ['', '0', '9', '2.5', 'abc']) {
      const r = validateForm('tour_next', { role: 'new_dev', stage: bad });
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.errors.stage).toBe('Stage must be a whole number from 1 to 8.');
    }
    expect(validateForm('tour_next', { role: 'new_dev', stage: ' 4 ' })).toMatchObject({ ok: true, data: { role: 'new_dev', stage: 4 } });
  });

  it('explains role, level and language mistakes', () => {
    expect(validateForm('tour_next', { role: 'boss', stage: '1' })).toMatchObject({ ok: false, errors: { role: 'Choose one of the four roles.' } });
    expect(validateForm('profile_contributor', { languages: 'TypeScript', level: 'wizard', areas: '' })).toMatchObject({ ok: false, errors: { level: 'Choose Beginner, Intermediate or Advanced.' } });
    expect(validateForm('profile_contributor', { languages: ' , ,', level: 'beginner', areas: '' })).toMatchObject({ ok: false, errors: { languages: expect.stringMatching(/at least one language/) } });
    expect(validateForm('profile_contributor', { languages: Array.from({ length: 13 }, (_, i) => `L${i}`).join(','), level: 'beginner', areas: '' })).toMatchObject({ ok: false, errors: { languages: 'Enter at most 12 languages.' } });
  });

  it('treats blank optional numbers as "use the default" and rejects out-of-range ones', () => {
    expect(validateForm('key_files', { role: 'reviewer', limit: '' })).toMatchObject({ ok: true, data: { role: 'reviewer', limit: undefined } });
    expect(validateForm('key_files', { role: 'reviewer', limit: '51' })).toMatchObject({ ok: false, errors: { limit: 'Files per group must be a whole number from 1 to 50.' } });
    expect(validateForm('trace_flow', { entry: '', depth: '7', maxFiles: '41' })).toMatchObject({ ok: false, errors: { depth: expect.stringMatching(/1 to 6/), maxFiles: expect.stringMatching(/1 to 40/) } });
    expect(validateForm('localize_issue', { issueNumber: '-3' })).toMatchObject({ ok: false, errors: { issueNumber: expect.stringMatching(/whole number/) } });
    expect(validateForm('localize_issue', { issueNumber: '1860' })).toMatchObject({ ok: true, data: { issueNumber: 1860 } });
  });

  it('splits lists on commas and trims them', () => {
    const r = validateForm('profile_contributor', { languages: ' TypeScript ,Python, ', level: 'advanced', areas: 'tests, docs' });
    expect(r).toMatchObject({ ok: true, data: { languages: ['TypeScript', 'Python'], level: 'advanced', areas: ['tests', 'docs'] } });
  });

  it('rejects over-long tokens and control characters in paths', () => {
    expect(validateForm('export_guide', { confirmToken: 'x'.repeat(201) })).toMatchObject({ ok: false });
    expect(validateForm('explain_file', { path: 'src/\u0001bad.ts' })).toMatchObject({ ok: false, errors: { path: expect.stringMatching(/unusual characters/) } });
  });

  it('reports an unknown tool instead of throwing', () => {
    expect(validateForm('not_a_tool', {})).toMatchObject({ ok: false });
  });

  it('has a form schema for exactly the 12 tools', () => {
    expect(Object.keys(FORM_SCHEMAS).sort()).toEqual(
      ['build_graph', 'project_overview', 'find_entry_points', 'key_files', 'trace_flow', 'explain_file', 'tour_next', 'profile_contributor', 'find_candidate_issues', 'localize_issue', 'score_first_change', 'export_guide'].sort(),
    );
  });
});

describe('what the website sends is accepted by the server tools', () => {
  const profile = (serverTool('score_first_change').options.examples!.request as { profile: Record<string, unknown> }).profile;
  const extras = { repo: 'lukeautry/tsoa', snapshotId: 'lukeautry__tsoa@f0f9aa7', entry: 'packages/cli/src/cli.ts', path: 'packages/cli/src/cli.ts', issueNumber: 1860, profile };

  it.each(TOOL_SPECS.map((s) => s.name))('%s: arguments built from the example form values pass the server schema', (name) => {
    const spec = TOOL_SPECS.find((t) => t.name === name)!;
    const values = Object.fromEntries(spec.fields.map((f) => [f.name, f.example ?? f.default]));
    const checked = validateForm(name, values);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const args = toolArgs(name, checked.data, extras);
    const result = serverTool(name).options.inputSchema.safeParse(args);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it.each(TOOL_SPECS.map((s) => s.name))('%s: arguments built from the default form values pass the server schema', (name) => {
    const spec = TOOL_SPECS.find((t) => t.name === name)!;
    const checked = validateForm(name, Object.fromEntries(spec.fields.map((f) => [f.name, f.default])));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const result = serverTool(name).options.inputSchema.safeParse(toolArgs(name, checked.data, extras));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('every stage and role the form offers is accepted by tour_next', () => {
    const spec = TOOL_SPECS.find((t) => t.name === 'tour_next')!;
    const roles = spec.fields.find((f) => f.name === 'role')!.options!;
    const stages = spec.fields.find((f) => f.name === 'stage')!.options!;
    expect(stages).toHaveLength(8);
    for (const r of roles) for (const s of stages) {
      const checked = validateForm('tour_next', { role: r.value, stage: s.value });
      expect(checked.ok).toBe(true);
      if (checked.ok) expect(serverTool('tour_next').options.inputSchema.safeParse(toolArgs('tour_next', checked.data, extras)).success, `${r.value} ${s.value}`).toBe(true);
    }
  });

  it('every level the form offers is accepted by the server', () => {
    const levels = TOOL_SPECS.find((t) => t.name === 'profile_contributor')!.fields.find((f) => f.name === 'level')!.options!;
    for (const l of levels) {
      const checked = validateForm('profile_contributor', { languages: 'TypeScript', level: l.value, areas: '' });
      expect(checked.ok).toBe(true);
      if (checked.ok) expect(serverTool('profile_contributor').options.inputSchema.safeParse(toolArgs('profile_contributor', checked.data, extras)).success, l.value).toBe(true);
    }
  });
});

describe('server answers are checked before the page trusts them', () => {
  it('accepts a normal build_graph answer and keeps extra fields', () => {
    const r = parseResponse(buildGraphResponse, { status: 'ready', snapshotId: 'a__b@1234567', source: 'built_on_demand', tier: 2, stats: { files: 3 } }, 'build_graph');
    expect(r.snapshotId).toBe('a__b@1234567');
    expect((r as Record<string, unknown>).tier).toBe(2);
  });

  it('explains an answer in an unexpected shape', () => {
    expect(() => parseResponse(buildGraphResponse, { status: 'maybe' }, 'build_graph')).toThrow(/build_graph answered in a shape this page does not understand \(status:/);
    expect(() => parseResponse(buildGraphResponse, 'just text', 'build_graph')).toThrow(/does not understand/);
    expect(() => parseResponse(candidatesResponse, { candidates: [{ number: 'seven' }] }, 'find_candidate_issues')).toThrow(/candidates\.0\.number/);
  });

  it('defaults a missing list to empty', () => {
    expect(parseResponse(candidatesResponse, {}, 'find_candidate_issues').candidates).toEqual([]);
  });
});

describe('tool guidance is complete', () => {
  it('describes every tool for a newcomer: purpose, when to use it, inputs, outputs and how to read the result', () => {
    expect(TOOL_SPECS).toHaveLength(12);
    for (const t of TOOL_SPECS) {
      expect(t.title.length, `${t.name} title`).toBeGreaterThan(5);
      expect(t.summary.length, `${t.name} summary`).toBeGreaterThan(60);
      expect(t.whenToUse.length, `${t.name} whenToUse`).toBeGreaterThan(20);
      expect(t.readIt.length, `${t.name} readIt`).toBeGreaterThan(40);
      expect(t.returns.length, `${t.name} returns`).toBeGreaterThanOrEqual(2);
      expect(GROUPS).toContain(t.group);
      if (t.fields.length === 0) expect(t.noInputNote, `${t.name} noInputNote`).toBeTruthy();
      for (const f of t.fields) {
        expect(f.help.length, `${t.name}.${f.name} help`).toBeGreaterThan(25);
        if (f.kind === 'select') expect(f.options?.length, `${t.name}.${f.name} options`).toBeGreaterThan(1);
      }
    }
  });

  it('only describes inputs the tools really have', () => {
    const helperOnly = new Set(['areas', 'languages', 'level']); // turned into a profile object by the explorer
    for (const t of TOOL_SPECS) {
      const server = serverTool(t.name).options.inputSchema as unknown as { shape?: Record<string, unknown> };
      const names = Object.keys(server.shape ?? {});
      for (const f of t.fields) {
        if (helperOnly.has(f.name)) continue;
        expect(names, `${t.name}.${f.name}`).toContain(f.name);
      }
    }
  });

  it('has a glossary with plain definitions', () => {
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(8);
    for (const g of GLOSSARY) expect(g.meaning.length).toBeGreaterThan(30);
  });
});
