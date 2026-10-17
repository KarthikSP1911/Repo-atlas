'use client';

import { useState } from 'react';
import { asRec, fmtDate, num, str, strList } from './demo-util';
import { Markdown } from './Markdown';
import { Card, LimitsBox, RawJson, RunStatus } from './ui';
import { useToolRun, type CallFn } from './useToolRun';

/** Card 6: the two-step export. Preview first, then confirm with the token to get the text. */
export function ExportStep({ call, snapshotId }: { call: CallFn; snapshotId: string }) {
  const preview = useToolRun(call);
  const draft = useToolRun(call);
  const refusal = useToolRun(call);
  const [copied, setCopied] = useState<string>('');
  const [view, setView] = useState<'formatted' | 'source'>('formatted');

  const p = asRec(preview.state.data);
  const pv = asRec(p.preview);
  const token = str(p.confirmToken);
  const d = asRec(draft.state.data);
  const markdown = str(d.markdown);

  const getPreview = (): void => {
    draft.reset();
    refusal.reset();
    setCopied('');
    void preview.run('export_guide', { snapshotId });
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied('Copied to the clipboard.');
    } catch {
      setCopied('Copy was blocked by the browser. Select the text and copy it by hand.');
    }
  };

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ARCHITECTURE.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Card n={6} title="Export a draft guide" tool="export_guide" blurb="Two steps on purpose: a preview first, then a confirmation token to get the text. The tool only returns text. It never writes to any repository." locked={false}>
      <button type="button" className="dm-btn primary" onClick={getPreview} disabled={preview.state.status === 'loading'}>
        Get the preview
      </button>
      <RunStatus state={preview.state} label="export_guide" onRetry={getPreview} />
      <p className="muted">If the server has no export secret configured, this tool returns an error, which is shown as is. Everything else in the demo still works.</p>

      {preview.state.status === 'done' && (
        <div className="dm-result">
          <h3>Preview: {str(pv.title)}</h3>
          <p className="dm-notice">Nothing is written anywhere. This only returns text to your browser.</p>
          <p className="muted">
            {num(pv.lines) ?? '?'} lines, {num(pv.characters) ?? '?'} characters. The confirmation token expires {fmtDate(p.expiresAt)}.
          </p>
          <h4>Sections</h4>
          <ol className="dm-list">
            {strList(pv.sections).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <h4>Excerpt</h4>
          <Markdown text={str(pv.excerpt)} />
          <div className="dm-actions">
            <button type="button" className="dm-btn primary" disabled={!token || draft.state.status === 'loading'} onClick={() => void draft.run('export_guide', { snapshotId, confirmToken: token })}>
              I confirm: get the draft
            </button>
            <button type="button" className="dm-btn" disabled={refusal.state.status === 'loading'} onClick={() => void refusal.run('export_guide', { snapshotId, confirmToken: 'not-a-real-token' })}>
              Try without confirming
            </button>
          </div>
          <RunStatus state={draft.state} label="export_guide" />
          {refusal.state.status === 'error' && (
            <div className="dm-refusal" aria-live="polite">
              <h4>The safety step worked</h4>
              <p>The server refused a made-up token:</p>
              <p className="dm-quote">{refusal.state.error}</p>
            </div>
          )}
          {refusal.state.status === 'done' && <p className="dm-error">The server accepted a made-up token. That should not happen; please report it.</p>}
          <RawJson value={preview.state.data} />
        </div>
      )}

      {draft.state.status === 'done' && (
        <div className="dm-result">
          <h3>
            {str(d.filename) || 'ARCHITECTURE.md'} <span className="muted">({num(d.characters) ?? markdown.length} characters)</span>
          </h3>
          {str(d.note) && <p className="dm-notice">{str(d.note)}</p>}
          <div className="dm-actions">
            <button type="button" className="dm-btn" onClick={() => void copy()}>
              Copy
            </button>
            <button type="button" className="dm-btn" onClick={download}>
              Download ARCHITECTURE.md
            </button>
          </div>
          <p className="muted" aria-live="polite">
            {copied}
          </p>
          <div className="dm-actions" role="group" aria-label="View">
            <button type="button" className={`dm-btn${view === 'formatted' ? ' primary' : ''}`} aria-pressed={view === 'formatted'} onClick={() => setView('formatted')}>
              Formatted
            </button>
            <button type="button" className={`dm-btn${view === 'source' ? ' primary' : ''}`} aria-pressed={view === 'source'} onClick={() => setView('source')}>
              Markdown source
            </button>
          </div>
          {view === 'formatted' ? (
            <Markdown text={markdown} />
          ) : (
            <pre className="dm-pre tall" tabIndex={0}>
              {markdown}
            </pre>
          )}
          <LimitsBox limits={d.limits} />
          <RawJson value={draft.state.data} />
        </div>
      )}
    </Card>
  );
}
