import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import * as core from '@nitrostack/core';
import { convertToModernJsonSchema } from '../node_modules/@nitrostack/core/dist/core/protocol/features/schema.js';
import { GraphTools } from '../src/modules/graph/graph.tools.js';
import { AnalysisTools } from '../src/modules/graph/analysis.tools.js';
import { ContributeTools } from '../src/modules/contribute/contribute.tools.js';
import { LocalizeTools } from '../src/modules/contribute/localize.tools.js';
import { TourTools } from '../src/modules/tour/tour.tools.js';
import { ActionsTools } from '../src/modules/actions/actions.tools.js';

/**
 * Regression gate for a failure unit tests cannot see. NitroStack's modern (default) protocol era
 * converts each tool's Zod schema to JSON Schema and hands it to the MCP SDK validator. If that
 * step throws for ANY tool, NitroStack silently falls back to a raw object and the SDK then
 * rejects it, so every request to the server fails ("must be a Standard Schema"). Real example:
 * `z.number().positive()` converts to the draft-04 `exclusiveMinimum: true`, which is rejected.
 * Use `.min(1)` instead of `.positive()`.
 */
const REQUIRED_TOOLS = [
  'build_graph', 'project_overview', 'find_entry_points', 'key_files', 'trace_flow', 'explain_file', 'tour_next',
  'profile_contributor', 'find_candidate_issues', 'localize_issue', 'score_first_change', 'export_guide',
];

type ToolMeta = { options: { name: string; inputSchema: unknown; examples?: { request?: unknown; response?: unknown } } };
const extractTools = (core as unknown as { extractTools: (c: unknown) => ToolMeta[] }).extractTools;
const classes = [GraphTools, AnalysisTools, ContributeTools, LocalizeTools, TourTools, ActionsTools];
const tools = classes.flatMap((c) => extractTools(c));

describe('tool schemas work with the modern protocol era', () => {
  it('registers exactly the 12 required tools plus ping, with unique names', () => {
    const names = tools.map((t) => t.options.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of REQUIRED_TOOLS) expect(names, n).toContain(n);
    expect(names.sort()).toEqual([...REQUIRED_TOOLS, 'ping_repoatlas'].sort());
  });

  it.each(tools.map((t) => [t.options.name, t] as const))('%s: schema converts and is accepted by the SDK', async (_name, t) => {
    const json = await convertToModernJsonSchema(t.options.inputSchema, { root: 'input' });
    expect(() => fromJsonSchema(json as never)).not.toThrow();
    expect(JSON.stringify(json)).not.toMatch(/"exclusive(Minimum|Maximum)":(true|false)/);
  });

  it.each(tools.map((t) => [t.options.name, t] as const))('%s: has an example request and response', (_name, t) => {
    expect(t.options.examples?.request).toBeDefined();
    expect(t.options.examples?.response).toBeDefined();
  });
});
