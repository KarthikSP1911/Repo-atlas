'use client';

import { useId, useMemo, useState } from 'react';
import { layoutSubgraph, subgraphOf } from '../lib/graph-layout';

/**
 * Draws the small import subgraph (at most 25 files) that tour_next and explain_file return, as
 * inline SVG: importers on the left, imported files on the right, the current stop highlighted.
 * Same approach as the graph-view widget; colours come from the page's CSS variables so dark
 * mode works. File names are untrusted: they are drawn as SVG text, never as HTML.
 */
export function GraphPanel({ output, onExplain, busy }: { output: unknown; onExplain?: (path: string) => void; busy?: boolean }) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const sg = useMemo(() => subgraphOf(output), [output]);
  const layout = useMemo(() => (sg ? layoutSubgraph(sg) : null), [sg]);
  const [picked, setPicked] = useState<string | null>(null);

  if (!sg || !layout || sg.nodes.length === 0) {
    return <p className="muted dm-nograph">No graph to draw for this result. Tier 1 repos have no import graph.</p>;
  }
  const selected = sg.nodes.find((n) => n.id === picked) ?? sg.nodes.find((n) => n.highlight) ?? sg.nodes[0];
  const pick = (id: string): void => setPicked(id);

  return (
    <figure className="dm-graph">
      <figcaption>
        <strong>Import graph</strong> <span className="muted">({sg.nodes.length} files, {layout.edges.length} imports drawn)</span>
      </figcaption>
      <div className="dm-graphscroll">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          style={{ width: '100%', minWidth: Math.min(layout.width, 520), height: 'auto', display: 'block' }}
          role="group"
          aria-label="Import graph of the highlighted files and their neighbours. Each box is a button."
        >
          <defs>
            <marker id={`${uid}-a`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="g-arrow" />
            </marker>
            <marker id={`${uid}-h`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="g-arrow hot" />
            </marker>
          </defs>
          {layout.edges.map((e) => {
            // Bright only for the selected file's own lines; the rest stays quiet so the picture is readable.
            const hot = e.from === selected.id || e.to === selected.id;
            return <path key={`${e.from}>${e.to}`} d={e.d} className={`g-edge${hot ? ' hot' : ''}`} markerEnd={`url(#${uid}-${hot ? 'h' : 'a'})`} />;
          })}
          {layout.nodes.map((p) => {
            const isSel = selected.id === p.node.id;
            const label = p.node.label.length > 26 ? `${p.node.label.slice(0, 25)}…` : p.node.label;
            return (
              <g
                key={p.node.id}
                className={`g-node${p.node.highlight ? ' hl' : ''}${isSel ? ' sel' : ''}`}
                tabIndex={0}
                role="button"
                aria-pressed={isSel}
                aria-label={`${p.node.path}${p.node.highlight ? ' (current stop)' : ''}`}
                onClick={() => pick(p.node.id)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    pick(p.node.id);
                  }
                }}
              >
                <title>{p.node.path}</title>
                <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={7} />
                <text x={p.x + p.w / 2} y={p.y + p.h / 2 + 4} textAnchor="middle" fontSize={11.5} fontWeight={p.node.highlight ? 700 : 400}>
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="muted dm-legend">
        Highlighted box: the current stop. Arrow: imports (importer to imported file). Click a box to light up its lines.
      </p>
      <div className="dm-picked" aria-live="polite">
        <span className="mono dm-break">{selected.path}</span>
        {selected.role ? <span className="muted"> ({selected.role})</span> : null}
        <span className="muted"> centrality {selected.centrality.toFixed(2)}</span>
        {onExplain && (
          <>
            {' '}
            <button type="button" className="dm-btn small" disabled={busy} onClick={() => onExplain(selected.path)}>
              Explain this file
            </button>
          </>
        )}
      </div>
      {sg.note && <p className="muted dm-legend">{sg.note}</p>}
    </figure>
  );
}
