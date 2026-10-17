'use client';

import { useState, type ReactNode } from 'react';
import { MISSING_SECRET_HINT, TIER_MEANING, asRec, fmtDate, looksLikeMissingSecret, num, prettyJson, safeGithubUrl, str, strList } from './demo-util';
import type { RunState } from './useToolRun';

/** Numbered card of the guided flow. Children are shown only when the card is unlocked. */
export function Card({ n, title, tool, blurb, locked, children }: { n: number; title: string; tool: string; blurb: string; locked: boolean; children: ReactNode }) {
  const id = `dm-card-${n}`;
  return (
    <section className={`dm-card${locked ? ' dm-locked' : ''}`} aria-labelledby={id}>
      <h2 id={id}>
        <span className="dm-num" aria-hidden="true">
          {n}
        </span>
        {title} <span className="dm-tool">{tool}</span>
      </h2>
      <p className="muted dm-blurb">{blurb}</p>
      {locked ? <p className="dm-lockmsg">Finish the previous step to unlock this one.</p> : children}
    </section>
  );
}

/** Live region with the loading text, or the error in red with a retry button. */
export function RunStatus({ state, label, onRetry }: { state: RunState; label: string; onRetry?: () => void }) {
  return (
    <div className="dm-status" aria-live="polite">
      {state.status === 'loading' && (
        <p className="dm-loading">
          <span className="dm-spin" aria-hidden="true" /> Calling {label}…
        </p>
      )}
      {state.status === 'error' && (
        <p className="dm-error">
          <strong>Error:</strong> {state.error}{' '}
          {onRetry && (
            <button type="button" className="dm-btn small" onClick={onRetry}>
              Retry
            </button>
          )}
        </p>
      )}
      {state.status === 'error' && looksLikeMissingSecret(state.error ?? '') && (
        <p className="dm-notice">
          <strong>Why:</strong> {MISSING_SECRET_HINT}
        </p>
      )}
    </div>
  );
}

/** Pretty JSON of what the agent receives, built only when opened and clipped to 20,000 characters. */
export function RawJson({ value, title = 'What the agent receives (raw JSON)', defaultOpen = false }: { value: unknown; title?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = open ? prettyJson(value) : null;
  return (
    <details className="dm-raw" open={defaultOpen} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{title}</summary>
      {shown && (
        <>
          <pre className="dm-pre" tabIndex={0}>
            {shown.text}
          </pre>
          {shown.clipped && <p className="muted">Clipped to the first {shown.text.length.toLocaleString()} of {shown.total.toLocaleString()} characters.</p>}
        </>
      )}
    </details>
  );
}

/** A file path that explains itself when clicked, or plain code when no handler is given. */
export function FileButton({ path, onExplain, busy }: { path: string; onExplain?: (path: string) => void; busy?: boolean }) {
  if (!onExplain) return <code className="dm-path">{path}</code>;
  return (
    <button type="button" className="dm-file" onClick={() => onExplain(path)} disabled={busy} title={`Explain ${path} with explain_file`}>
      {path}
    </button>
  );
}

/** The limits envelope every tool returns: tier, commit window, as-of date, truncation, caveats. */
export function LimitsBox({ limits, open }: { limits: unknown; open?: boolean }) {
  const l = asRec(limits);
  if (Object.keys(l).length === 0) return null;
  const tier = num(l.tier);
  const notes = strList(l.notes);
  return (
    <details className="dm-limits" open={open}>
      <summary>Limits and caveats{tier !== null ? ` (tier ${tier}${l.truncated === true ? ', truncated' : ''})` : ''}</summary>
      <ul>
        {tier !== null && <li>{str(l.tierNote) || TIER_MEANING[tier] || `Tier ${tier}`}</li>}
        {num(l.commitWindow) !== null && <li>History window: last {num(l.commitWindow)} commits.</li>}
        <li>Snapshot as of {fmtDate(l.asOf)}. The repo may have changed since.</li>
        <li>{l.truncated === true ? 'Truncated: size caps were applied, so this is a partial graph.' : 'Not truncated.'}</li>
        {notes.filter((n) => n !== str(l.tierNote)).map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </details>
  );
}

/** GitHub links only; anything else is plain text. */
export function SafeLink({ url, children }: { url: unknown; children: ReactNode }) {
  const safe = safeGithubUrl(url);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function Chips({ items, label }: { items: string[]; label?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="dm-chips" aria-label={label}>
      {items.map((t, i) => (
        <li key={`${t}-${i}`} className="chip">
          {t}
        </li>
      ))}
    </ul>
  );
}
