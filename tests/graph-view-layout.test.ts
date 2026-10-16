import { describe, expect, it } from 'vitest';
import { MAX_NODES, assignLayers, layoutSubgraph, nodeWidth, subgraphOf, type SgNode } from '../src/widgets/app/graph-view/graph-layout.js';

const node = (id: string, over: Partial<SgNode> = {}): SgNode => ({ id, label: id.split('/').pop()!, path: id, centrality: 0, highlight: false, ...over });

describe('assignLayers', () => {
  it('puts importers left and imported files right of the highlighted file', () => {
    const nodes = [node('routes.ts'), node('service.ts', { highlight: true }), node('db.ts'), node('logger.ts')];
    const edges = [{ from: 'routes.ts', to: 'service.ts' }, { from: 'service.ts', to: 'db.ts' }, { from: 'service.ts', to: 'logger.ts' }];
    const l = assignLayers(nodes, edges);
    expect(l.get('routes.ts')).toBe(0);
    expect(l.get('service.ts')).toBe(1);
    expect(l.get('db.ts')).toBe(2);
    expect(l.get('logger.ts')).toBe(2);
  });

  it('handles cycles, self edges, unknown ids and unreachable nodes without looping', () => {
    const nodes = [node('a', { highlight: true }), node('b'), node('lonely')];
    const l = assignLayers(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'a', to: 'a' }, { from: 'a', to: 'ghost' }]);
    expect([...l.values()].every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
    expect(l.has('lonely')).toBe(true);
  });

  it('works with no highlight by starting from the first node', () => {
    const l = assignLayers([node('a'), node('b')], [{ from: 'a', to: 'b' }]);
    expect(l.get('a')).toBeLessThan(l.get('b')!);
  });
});

describe('layoutSubgraph', () => {
  const nodes = [node('src/routes/orders.ts'), node('src/services/order.service.ts', { highlight: true, centrality: 0.5 }), node('src/db/client.ts', { centrality: 0.6 }), node('src/utils/logger.ts', { centrality: 1 })];
  const edges = [{ from: 'src/routes/orders.ts', to: 'src/services/order.service.ts' }, { from: 'src/services/order.service.ts', to: 'src/db/client.ts' }, { from: 'src/services/order.service.ts', to: 'src/utils/logger.ts' }];

  it('is deterministic and stays inside its own bounds', () => {
    const a = layoutSubgraph({ nodes, edges });
    expect(JSON.stringify(layoutSubgraph({ nodes, edges }))).toBe(JSON.stringify(a));
    for (const p of a.nodes) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w).toBeLessThanOrEqual(a.width);
      expect(p.y + p.h).toBeLessThanOrEqual(a.height);
    }
  });

  it('never overlaps two nodes in the same column', () => {
    const l = layoutSubgraph({ nodes, edges });
    for (const a of l.nodes) for (const b of l.nodes) if (a !== b && a.layer === b.layer) expect(a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
  });

  it('keeps the highlighted node first in its column and emphasises its edges', () => {
    const l = layoutSubgraph({ nodes, edges });
    expect(l.edges).toHaveLength(3);
    expect(l.edges.every((e) => e.emphasis)).toBe(true);
    expect(l.edges.every((e) => /^M[\d.]+,[\d.]+ C/.test(e.d))).toBe(true);
    const col = l.nodes.filter((p) => p.layer === 2).sort((a, b) => a.y - b.y);
    expect(col.map((p) => p.node.label)).toEqual(['logger.ts', 'client.ts']); // higher centrality first
  });

  it('caps at 25 nodes, drops duplicate and dangling edges, and handles an empty graph', () => {
    const many = Array.from({ length: 40 }, (_, i) => node(`f${i}.ts`, { highlight: i === 0 }));
    const l = layoutSubgraph({ nodes: many, edges: [{ from: 'f0.ts', to: 'f1.ts' }, { from: 'f0.ts', to: 'f1.ts' }, { from: 'f0.ts', to: 'f39.ts' }] });
    expect(l.nodes).toHaveLength(MAX_NODES);
    expect(l.edges).toHaveLength(1);
    const empty = layoutSubgraph({ nodes: [], edges: [] });
    expect(empty.nodes).toEqual([]);
    expect(empty.width).toBeGreaterThan(0);
  });

  it('sizes nodes by label within limits', () => {
    expect(nodeWidth('a')).toBe(70);
    expect(nodeWidth('x'.repeat(200))).toBe(190);
  });
});

describe('subgraphOf (reads tool output safely)', () => {
  it('reads tour_next / explain_file output and a bare subgraph', () => {
    const sg = { nodes: [{ id: 'a', label: 'a.ts', path: 'a.ts', centrality: 0.5, highlight: true, role: 'util' }], edges: [{ from: 'a', to: 'a' }], highlight: ['a'], note: 'n' };
    expect(subgraphOf({ stage: 4, subgraph: sg })?.nodes[0]).toMatchObject({ id: 'a', highlight: true, role: 'util' });
    expect(subgraphOf(sg)?.note).toBe('n');
  });

  it('returns null for anything that is not a subgraph and sanitises odd node data', () => {
    expect(subgraphOf(null)).toBeNull();
    expect(subgraphOf({ stage: 1 })).toBeNull();
    expect(subgraphOf('text')).toBeNull();
    const r = subgraphOf({ subgraph: { nodes: [{ id: 'ok', label: 'x'.repeat(500), centrality: 'bad' }, { nope: true }, null], edges: 'nope' } })!;
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0].label).toHaveLength(60);
    expect(r.nodes[0].centrality).toBe(0);
    expect(r.edges).toEqual([]);
  });
});
