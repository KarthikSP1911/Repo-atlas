'use client';

import { useEffect, useState } from 'react';
import { useTheme, useWidgetSDK, useWidgetState } from '@nitrostack/widgets';
import { layoutSubgraph, subgraphOf } from './graph-layout';

/**
 * graph-view: draws the small import subgraph (at most 25 files) that tour_next and explain_file
 * return, with the current stop highlighted. It renders only what the tool sent. All ranking and
 * every fact come from the tools; file names and text here are untrusted repo data, drawn as
 * plain SVG text (never as HTML).
 */

interface ToolOutput {
  stage?: number;
  name?: string;
  progress?: string;
  path?: string;
  role?: string;
  checkQuestion?: { question?: string };
  limits?: { snapshotId?: string; asOf?: string; tier?: number; truncated?: boolean };
  subgraph?: unknown;
}

const palette = (dark: boolean) => ({
  bg: dark ? '#0f172a' : '#ffffff',
  panel: dark ? '#1e293b' : '#f8fafc',
  text: dark ? '#e2e8f0' : '#0f172a',
  muted: dark ? '#94a3b8' : '#475569',
  border: dark ? '#334155' : '#cbd5e1',
  node: dark ? '#273449' : '#eef2f7',
  focus: dark ? '#f59e0b' : '#b45309',
  focusFill: dark ? '#3b2f12' : '#fef3c7',
  edge: dark ? '#64748b' : '#94a3b8',
  edgeFocus: dark ? '#fbbf24' : '#b45309',
});

export default function GraphView() {
  const theme = useTheme();
  // `toolOutput` is read only so this component re-renders when the host delivers the result.
  // Do not gate on `isReady`: some hosts (NitroStudio) provide the data without the ready event
  // the flag waits for, which left the widget stuck on "Waiting for the tool result...".
  const { toolOutput, getToolOutput, sendFollowUpMessage } = useWidgetSDK();
  const [state, setState] = useWidgetState<{ selected: string | null }>(() => ({ selected: null }));
  const c = palette(theme === 'dark');

  // Safety net: if the host's result arrives without any event reaching the hooks, look again every
  // 300 ms for up to 15 s, then say so instead of waiting forever.
  const [, setTick] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  const output = getToolOutput<ToolOutput>() ?? (toolOutput ? (subgraphOf(toolOutput) ? (toolOutput as ToolOutput) : null) : null);
  const have = output !== null;
  useEffect(() => {
    if (have) return;
    const poll = setInterval(() => setTick((t) => t + 1), 300);
    const stop = setTimeout(() => setGaveUp(true), 15_000);
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, [have]);
  const sg = output ? subgraphOf(output) : null;

  const frame = { fontFamily: 'system-ui, sans-serif', fontSize: 13, color: c.text, background: c.bg, padding: 12, borderRadius: 10, border: `1px solid ${c.border}`, maxWidth: 900 } as const;

  if (!output) {
    return (
      <div style={{ ...frame, color: c.muted }}>
        {gaveUp ? 'No result reached this widget from the host. Run the tool again, or ask the agent for the result in text.' : 'Waiting for the tool result...'}
      </div>
    );
  }
  if (!sg || sg.nodes.length === 0) {
    return <div style={{ ...frame, color: c.muted }}>No graph to draw for this result. The snapshot may have no import data (Tier 1).</div>;
  }

  const layout = layoutSubgraph(sg);
  const selected = sg.nodes.find((n) => n.id === state?.selected) ?? sg.nodes.find((n) => n.highlight) ?? sg.nodes[0];
  const title = output.name ? `${output.progress ? `${output.progress}: ` : ''}${output.name}` : output.path ? `Around ${output.path}` : 'Import graph';

  return (
    <div style={frame}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 15 }}>{title}</strong>
        <span style={{ color: c.muted, fontSize: 12 }}>
          {sg.nodes.length} files{output.limits?.tier === 1 ? ' | Tier 1: no import graph' : ''}{output.limits?.truncated ? ' | partial snapshot' : ''}
        </span>
      </div>

      <div style={{ overflowX: 'auto', marginTop: 8, background: c.panel, borderRadius: 8, border: `1px solid ${c.border}` }}>
        <svg viewBox={`0 0 ${layout.width} ${layout.height}`} style={{ width: '100%', minWidth: Math.min(layout.width, 520), height: 'auto', display: 'block' }} role="img" aria-label="Import graph of the highlighted files and their neighbours">
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill={c.edge} />
            </marker>
            <marker id="arrow-focus" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill={c.edgeFocus} />
            </marker>
          </defs>
          {layout.edges.map((e) => {
            // Bright only for the selected file's own lines; everything else stays quiet so the picture is readable.
            const hot = selected ? e.from === selected.id || e.to === selected.id : e.emphasis;
            return <path key={`${e.from}>${e.to}`} d={e.d} fill="none" stroke={hot ? c.edgeFocus : c.edge} strokeWidth={hot ? 1.8 : 0.9} opacity={hot ? 0.95 : 0.35} markerEnd={`url(#${hot ? 'arrow-focus' : 'arrow'})`} />;
          })}
          {layout.nodes.map((p) => {
            const isSel = selected?.id === p.node.id;
            return (
              <g key={p.node.id} onClick={() => setState({ selected: p.node.id })} style={{ cursor: 'pointer' }} tabIndex={0} role="button" aria-label={`${p.node.path}${p.node.highlight ? ' (current stop)' : ''}`} onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') setState({ selected: p.node.id }); }}>
                <title>{p.node.path}</title>
                <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={7} fill={p.node.highlight ? c.focusFill : c.node} stroke={p.node.highlight ? c.focus : isSel ? c.text : c.border} strokeWidth={p.node.highlight || isSel ? 2 : 1} />
                <text x={p.x + p.w / 2} y={p.y + p.h / 2 + 4} textAnchor="middle" fontSize={11.5} fill={c.text} fontWeight={p.node.highlight ? 700 : 400}>
                  {p.node.label.length > 26 ? `${p.node.label.slice(0, 25)}…` : p.node.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div style={{ marginTop: 8, display: 'flex', gap: 14, flexWrap: 'wrap', color: c.muted, fontSize: 12 }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: c.focusFill, border: `2px solid ${c.focus}`, borderRadius: 3, marginRight: 5 }} />current stop</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: c.node, border: `1px solid ${c.border}`, borderRadius: 3, marginRight: 5 }} />neighbour</span>
        <span>arrow: imports (importer to imported file). Click a box to light up its lines.</span>
      </div>

      {selected && (
        <div style={{ marginTop: 8, padding: 8, background: c.panel, border: `1px solid ${c.border}`, borderRadius: 8 }}>
          <div style={{ wordBreak: 'break-all' }}><strong>{selected.path}</strong>{selected.role ? <span style={{ color: c.muted }}> ({selected.role})</span> : null}</div>
          <div style={{ color: c.muted, marginTop: 2 }}>centrality {selected.centrality.toFixed(2)}</div>
          <button type="button" onClick={() => sendFollowUpMessage(`Explain ${selected.path} using explain_file`)} style={{ marginTop: 6, padding: '4px 10px', borderRadius: 6, border: `1px solid ${c.border}`, background: c.bg, color: c.text, cursor: 'pointer', fontSize: 12 }}>
            Ask about this file
          </button>
        </div>
      )}

      {output.checkQuestion?.question && (
        <div style={{ marginTop: 8, color: c.text }}>
          <span style={{ color: c.muted }}>Check yourself: </span>{output.checkQuestion.question}
        </div>
      )}
      {sg.note && <div style={{ marginTop: 6, color: c.muted, fontSize: 12 }}>{sg.note}</div>}
      {output.limits?.asOf && <div style={{ marginTop: 6, color: c.muted, fontSize: 11 }}>Snapshot as of {output.limits.asOf}</div>}
    </div>
  );
}
