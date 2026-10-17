'use client';

import { useState } from 'react';
import { shortArgs } from './demo-util';
import { RawJson } from './ui';

export interface LogEntry {
  id: number;
  time: string;
  tool: string;
  args: Record<string, unknown>;
  ms: number;
  ok: boolean;
  error?: string;
  /** The full JSON-RPC message, or the error text, shown when the entry is selected. */
  raw: unknown;
}

/** Every tool call the page makes, newest first. Select one to see the raw JSON-RPC reply. */
export function CallLog({ entries, onClear }: { entries: LogEntry[]; onClear: () => void }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = entries.find((e) => e.id === selectedId) ?? null;
  return (
    <section className="dm-card" aria-labelledby="dm-log-h">
      <h2 id="dm-log-h">
        Tool calls <span className="muted dm-small">({entries.length})</span>
      </h2>
      {entries.length === 0 ? (
        <p className="muted">Nothing yet. Every call the buttons below make is listed here, with what the server sent back.</p>
      ) : (
        <>
          <div className="dm-tablewrap dm-logscroll">
            <table className="dm-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Tool</th>
                  <th scope="col">Arguments</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className={e.id === selectedId ? 'on' : ''}>
                    <td>{e.time}</td>
                    <td>
                      <button type="button" className="dm-link" aria-pressed={e.id === selectedId} onClick={() => setSelectedId(e.id === selectedId ? null : e.id)}>
                        {e.tool}
                      </button>
                    </td>
                    <td className="mono muted">{shortArgs(e.args)}</td>
                    <td>{e.ms} ms</td>
                    <td className={e.ok ? 'dm-ok' : 'dm-bad'}>{e.ok ? 'ok' : 'error'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dm-actions">
            <button type="button" className="dm-btn small" onClick={onClear}>
              Clear log
            </button>
          </div>
        </>
      )}
      <div aria-live="polite">
        {selected && (
          <>
            {!selected.ok && selected.error && (
              <p className="dm-error">
                <strong>Error:</strong> {selected.error}
              </p>
            )}
            <RawJson key={selected.id} defaultOpen value={{ request: { tool: selected.tool, arguments: selected.args }, response: selected.raw }} title={`Raw JSON for ${selected.tool} at ${selected.time}`} />
          </>
        )}
      </div>
    </section>
  );
}
