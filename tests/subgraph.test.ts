import { describe, expect, it } from 'vitest';
import { GraphIndex } from '../src/services/graph.query.js';
import { StoreService } from '../src/services/store.service.js';
import { buildSubgraph } from '../src/services/tool.util.js';
import { MAX_EDGES, layoutSubgraph } from '../src/widgets/app/graph-view/graph-layout.js';

/** Regression: Studio showed a 25-node, 100-edge hairball where 10 nodes were test files. */
describe('widget subgraph is readable on a real repo (tsoa)', async () => {
  const store = new StoreService();
  store.dir = 'data/snapshots';
  const idx = new GraphIndex(await store.load('tsoa'));
  const highlight = ['packages/runtime/src/index.ts', 'packages/cli/src/cli.ts', 'packages/cli/src/metadataGeneration/typeResolver.ts'];

  it('has at most 25 nodes and keeps test files out of the neighbours', () => {
    const sg = buildSubgraph(idx, highlight);
    expect(sg.nodes.length).toBeLessThanOrEqual(25);
    expect(sg.nodes.filter((n) => n.highlight).map((n) => n.path).sort()).toEqual([...highlight].sort());
    const tests = sg.nodes.filter((n) => idx.files.get(n.path)?.meta.isTest);
    expect(tests).toEqual([]);
  });

  it('still shows tests when the file being explained is itself a test', () => {
    const testFile = [...idx.files.values()].find((f) => f.meta.isTest && idx.imports(f.path).length > 0)!;
    const sg = buildSubgraph(idx, [testFile.path]);
    expect(sg.nodes.some((n) => n.highlight && n.path === testFile.path)).toBe(true);
    expect(sg.nodes.length).toBeGreaterThan(1);
  });

  it('draws a bounded number of edges, keeping those that touch the highlighted files', () => {
    const sg = buildSubgraph(idx, highlight);
    expect(sg.edges.length).toBeGreaterThan(MAX_EDGES); // the raw subgraph is dense...
    const layout = layoutSubgraph(sg);
    expect(layout.edges.length).toBeLessThanOrEqual(MAX_EDGES); // ...but the picture is not
    const hl = new Set(highlight);
    const touching = sg.edges.filter((e) => hl.has(e.from) || hl.has(e.to)).length;
    expect(layout.edges.filter((e) => e.emphasis).length).toBe(Math.min(touching, MAX_EDGES));
  });
});
