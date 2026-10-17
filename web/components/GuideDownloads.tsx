'use client';

import { useState } from 'react';
import { makeGuidePdf } from '../lib/guide-pdf';

function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copy, Download .md and Download PDF for the finished guide. Everything happens in the browser. */
export function GuideDownloads({ markdown, filename = 'ARCHITECTURE.md' }: { markdown: string; filename?: string }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const base = filename.replace(/\.md$/i, '') || 'ARCHITECTURE';

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(markdown);
      setMessage('Copied the Markdown to the clipboard.');
    } catch {
      setMessage('Copy was blocked by the browser. Download the file instead.');
    }
  };

  const pdf = async (): Promise<void> => {
    setBusy(true);
    setMessage('');
    try {
      const title = /^#\s+(.+)$/m.exec(markdown)?.[1] ?? base;
      save(await makeGuidePdf(markdown, title), `${base}.pdf`);
      setMessage(`Downloaded ${base}.pdf.`);
    } catch {
      setMessage('Could not make the PDF in this browser. Download the Markdown file instead.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gd">
      <div className="dm-actions" role="group" aria-label="Save the guide">
        <button type="button" className="dm-btn primary" onClick={() => save(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${base}.md`)}>
          Download .md
        </button>
        <button type="button" className="dm-btn primary" disabled={busy} onClick={() => void pdf()}>
          {busy ? 'Making PDF…' : 'Download PDF'}
        </button>
        <button type="button" className="dm-btn" onClick={() => void copy()}>
          Copy Markdown
        </button>
      </div>
      <p className="muted" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
