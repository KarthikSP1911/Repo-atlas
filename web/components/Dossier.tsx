'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { GenericValue } from './GenericValue';
import { GraphPanel } from './GraphPanel';
import { asRec, fmtDate, num, recList, str, strList } from './demo-util';
import { FileButton, LimitsBox, RawJson, RunStatus } from './ui';
import { useToolRun, type CallFn, type RunState } from './useToolRun';

export interface ExplainHandle {
  state: RunState;
  path: string | null;
  busy: boolean;
  /** Increments on every explain call so the panel can scroll into view. */
  seq: number;
  explain: (path: string) => void;
}

/** One explain_file call at a time; the paths shown anywhere in a card call `explain`. */
export function useExplain(call: CallFn, snapshotId: string): ExplainHandle {
  const { state, run } = useToolRun(call);
  const [path, setPath] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  const explain = useCallback(
    (p: string) => {
      setPath(p);
      setSeq((n) => n + 1);
      void run('explain_file', { snapshotId, path: p });
    },
    [run, snapshotId],
  );
  return { state, path, busy: state.status === 'loading', seq, explain };
}

function Facts({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="dm-fact">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function PathList({ items, total, onExplain, busy }: { items: unknown; total?: number | null; onExplain: (p: string) => void; busy: boolean }) {
  const list = asRecOrString(items);
  if (list.length === 0) return <span className="muted">none</span>;
  return (
    <>
      <ul className="dm-list">
        {list.map((p, i) => (
          <li key={`${p.path}-${i}`}>
            <FileButton path={p.path} onExplain={onExplain} busy={busy} />
            {p.weight !== null && p.weight > 1 ? <span className="muted"> (weight {p.weight})</span> : null}
          </li>
        ))}
      </ul>
      {total != null && total > list.length && <p className="muted">Showing {list.length} of {total}.</p>}
    </>
  );
}

function asRecOrString(items: unknown): { path: string; weight: number | null }[] {
  if (!Array.isArray(items)) return [];
  const out: { path: string; weight: number | null }[] = [];
  for (const it of items) {
    if (typeof it === 'string') out.push({ path: it, weight: null });
    else {
      const r = asRec(it);
      if (typeof r.path === 'string') out.push({ path: r.path, weight: num(r.weight) });
    }
  }
  return out;
}

/** The file dossier from explain_file. */
export function DossierPanel({ handle, retry }: { handle: ExplainHandle; retry?: () => void }) {
  const { state, path, explain, busy, seq } = handle;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (seq > 0) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [seq]);
  const d = asRec(state.data);
  const m = asRec(d.metrics);
  const conf = asRec(d.confidence);
  const hasData = state.status === 'done' && Object.keys(d).length > 0;
  return (
    <div className="dm-dossier" aria-live="polite" ref={ref}>
      {path && (
        <h3>
          File dossier: <code className="dm-break">{path}</code>
        </h3>
      )}
      {path && <RunStatus state={state} label="explain_file" onRetry={retry ?? (() => explain(path))} />}
      {hasData && (
        <>
          <div className="dm-facts">
            <Facts title="Role">
              <p>
                {str(d.role) || 'unknown'}
                {str(d.lang) ? <span className="muted"> ({str(d.lang)})</span> : null}
              </p>
              {strList(d.roleSignals).length > 0 && (
                <ul className="dm-list">
                  {strList(d.roleSignals).map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              )}
            </Facts>
            <Facts title="Numbers">
              <p>
                {num(m.loc) !== null ? `${num(m.loc)} lines` : ''}
                {num(m.fanIn) !== null ? `, imported by ${num(m.fanIn)}` : ''}
                {num(m.fanOut) !== null ? `, imports ${num(m.fanOut)}` : ''}
                {num(m.churn) !== null ? `, changed ${num(m.churn)} times` : ''}
              </p>
              {num(m.centrality) !== null && <p className="muted">Centrality {num(m.centrality)?.toFixed(2)}. Last changed {fmtDate(m.lastChangedAt)}.</p>}
            </Facts>
            <Facts title="Confidence">
              <p>
                <strong>{str(conf.level) || 'unknown'}</strong>
              </p>
              <p className="muted">{str(conf.reason)}</p>
            </Facts>
          </div>

          {strList(d.evidence).length > 0 && (
            <Facts title="Evidence">
              <ul className="dm-list">
                {strList(d.evidence).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </Facts>
          )}

          <div className="dm-facts two">
            <Facts title={`Imports (${num(d.importsTotal) ?? 0})`}>
              <PathList items={d.imports} total={num(d.importsTotal)} onExplain={explain} busy={busy} />
            </Facts>
            <Facts title={`Imported by (${num(d.importedByTotal) ?? 0})`}>
              <PathList items={d.importedBy} total={num(d.importedByTotal)} onExplain={explain} busy={busy} />
            </Facts>
            <Facts title="Tests for this file">
              <PathList items={asArrayHead(d.testedBy, 8)} total={Array.isArray(d.testedBy) ? d.testedBy.length : null} onExplain={explain} busy={busy} />
            </Facts>
            <Facts title="This file tests">
              <PathList items={d.testFor} onExplain={explain} busy={busy} />
            </Facts>
          </div>

          <div className="dm-facts two">
            <Facts title="Owners (by commits)">
              {recList(d.owners).length === 0 ? (
                <span className="muted">none found</span>
              ) : (
                <ul className="dm-list">
                  {recList(d.owners).map((o, i) => (
                    <li key={i}>{str(o.name) || 'unknown'}</li>
                  ))}
                </ul>
              )}
            </Facts>
            <Facts title="Recent commits">
              {recList(d.recentCommits).length === 0 ? (
                <span className="muted">none</span>
              ) : (
                <ul className="dm-list">
                  {recList(d.recentCommits).map((c, i) => (
                    <li key={i}>
                      <code>{str(c.sha7)}</code> {str(c.subject)} <span className="muted">({str(c.author)}, {str(c.date).slice(0, 10)})</span>
                    </li>
                  ))}
                </ul>
              )}
            </Facts>
          </div>

          {recList(d.mergedPrs).length > 0 && (
            <Facts title="Merged pull requests">
              <ul className="dm-list">
                {recList(d.mergedPrs).map((p, i) => (
                  <li key={i}>
                    #{str(p.number)} {str(p.title)} <span className="muted">({str(p.author)}, {str(p.mergedAt).slice(0, 10)})</span>
                  </li>
                ))}
              </ul>
            </Facts>
          )}
          {(strList(d.exports).length > 0 || strList(d.symbols).length > 0 || recList(d.changesWith).length > 0 || strList(d.docsMentioning).length > 0) && (
            <Facts title="More">
              <GenericValue value={{ exports: d.exports, symbols: d.symbols, docsMentioning: d.docsMentioning, changesWith: d.changesWith }} onExplain={explain} busy={busy} />
            </Facts>
          )}

          <GraphPanel output={d} onExplain={explain} busy={busy} />
          <LimitsBox limits={d.limits} />
          <RawJson value={state.data} />
        </>
      )}
    </div>
  );
}

function asArrayHead(v: unknown, n: number): unknown[] {
  return Array.isArray(v) ? v.slice(0, n) : [];
}
