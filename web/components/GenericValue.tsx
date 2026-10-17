'use client';

import { useState } from 'react';
import { clip, humanize, isRec, looksLikePath, type Rec } from './demo-util';
import { FileButton } from './ui';

/**
 * Readable renderer for tool output of any shape: objects become definition lists, lists of
 * strings become bullet lists, lists of flat objects become tables, other lists become cards.
 * Every string is plain React text (it comes from untrusted repo data).
 */

const MAX_ITEMS = 12;
const MAX_DEPTH = 5;
const CLIP_AT = 300;
const HIDDEN_KEYS = new Set(['untrustedFields']);

interface Props {
  value: unknown;
  depth?: number;
  onExplain?: (path: string) => void;
  busy?: boolean;
}

export function ClipText({ text, max = CLIP_AT }: { text: string; max?: number }) {
  const [open, setOpen] = useState(false);
  if (text.length <= max) return <span className="dm-text">{text}</span>;
  return (
    <span className="dm-text">
      {open ? text : clip(text, max)}{' '}
      <button type="button" className="dm-link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'show less' : 'show more'}
      </button>
    </span>
  );
}

function Primitive({ v, onExplain, busy, max }: { v: unknown; onExplain?: (p: string) => void; busy?: boolean; max?: number }) {
  if (v === null || v === undefined || v === '') return <span className="muted">none</span>;
  if (typeof v === 'string') return looksLikePath(v) && onExplain ? <FileButton path={v} onExplain={onExplain} busy={busy} /> : <ClipText text={v} max={max} />;
  return <>{String(v)}</>;
}

const isPrimitive = (v: unknown): boolean => v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);
const isPrimitiveList = (v: unknown): boolean => Array.isArray(v) && v.length <= 8 && v.every(isPrimitive);
/** An object whose values are all plain (for example a score broken into its parts). */
const isFlatRec = (v: unknown): boolean => isRec(v) && Object.keys(v).length <= 12 && Object.values(v).every(isPrimitive);

const isEmptyValue = (v: unknown): boolean => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (isRec(v) && Object.keys(v).length === 0);

function tableKeys(items: Rec[]): string[] | null {
  const all: string[] = [];
  for (const it of items) for (const k of Object.keys(it)) if (!HIDDEN_KEYS.has(k) && !all.includes(k)) all.push(k);
  // A column that is empty in every row says nothing; the full data stays in the raw JSON.
  const keys = all.filter((k) => items.some((it) => !isEmptyValue(it[k])));
  if (keys.length === 0 || keys.length > 10) return null;
  for (const it of items) for (const k of keys) if (!isPrimitive(it[k]) && !isPrimitiveList(it[k]) && !isFlatRec(it[k])) return null;
  return keys;
}

/** Short values (numbers, single words) read better as chips than as a tall bullet list. */
const isChipList = (items: unknown[]): boolean => items.length <= 40 && items.every((x) => typeof x === 'number' || (typeof x === 'string' && x.length <= 24 && !looksLikePath(x)));

const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

function Cell({ v, onExplain, busy }: { v: unknown; onExplain?: (p: string) => void; busy?: boolean }) {
  if (isFlatRec(v)) {
    // Zero-valued parts say nothing (a score broken into 12 parts is mostly zeros), so only the non-zero ones are shown.
    const entries = Object.entries(v as Rec).filter(([, x]) => x !== null && x !== undefined && x !== '' && x !== 0 && x !== false);
    if (entries.length === 0) return <span className="muted">none</span>;
    return (
      <span className="dm-kv">
        {entries.map(([k, x]) => (
          <span key={k} className="chip">
            {humanize(k)} <strong>{typeof x === 'number' ? fmtNum(x) : String(x)}</strong>
          </span>
        ))}
      </span>
    );
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="muted">none</span>;
    // Sentences read better as a short list than as one long comma-joined line.
    if (v.some((x) => typeof x === 'string' && x.length > 48)) {
      return (
        <ul className="dm-list tight">
          {v.map((x, i) => (
            <li key={i}>
              <Primitive v={x} onExplain={onExplain} busy={busy} max={160} />
            </li>
          ))}
        </ul>
      );
    }
    return (
      <span className="dm-inline">
        {v.map((x, i) => (
          <span key={i}>
            <Primitive v={x} onExplain={onExplain} busy={busy} max={120} />
            {i < v.length - 1 ? ', ' : ''}
          </span>
        ))}
      </span>
    );
  }
  return <Primitive v={v} onExplain={onExplain} busy={busy} max={160} />;
}

function ListView({ items, depth, onExplain, busy }: { items: unknown[]; depth: number; onExplain?: (p: string) => void; busy?: boolean }) {
  const [shown, setShown] = useState(MAX_ITEMS);
  if (items.length === 0) return <span className="muted">none</span>;
  const visible = items.slice(0, shown);
  const more = items.length > shown ? (
    <button type="button" className="dm-link" onClick={() => setShown(shown + MAX_ITEMS)}>
      show {Math.min(MAX_ITEMS, items.length - shown)} more ({items.length - shown} hidden)
    </button>
  ) : null;

  if (items.every(isPrimitive) && isChipList(items)) {
    return (
      <ul className="dm-chips" aria-label="values">
        {items.map((x, i) => (
          <li key={i} className="chip">
            {String(x)}
          </li>
        ))}
      </ul>
    );
  }

  if (items.every(isPrimitive)) {
    return (
      <>
        <ul className="dm-list">
          {visible.map((x, i) => (
            <li key={i}>
              <Primitive v={x} onExplain={onExplain} busy={busy} />
            </li>
          ))}
        </ul>
        {more}
      </>
    );
  }

  if (items.every(isRec)) {
    const recs = visible.filter(isRec);
    const keys = tableKeys(recs);
    if (keys) {
      return (
        <>
          <div className="dm-tablewrap">
            <table className="dm-table">
              <thead>
                <tr>
                  {keys.map((k) => (
                    <th key={k} scope="col">
                      {humanize(k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recs.map((r, i) => (
                  <tr key={i}>
                    {keys.map((k) => (
                      <td key={k}>
                        <Cell v={r[k]} onExplain={onExplain} busy={busy} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {more}
        </>
      );
    }
    return (
      <>
        <div className="dm-cards">
          {recs.map((r, i) => (
            <div key={i} className="dm-mini">
              <GenericValue value={r} depth={depth + 1} onExplain={onExplain} busy={busy} />
            </div>
          ))}
        </div>
        {more}
      </>
    );
  }

  return (
    <>
      <ul className="dm-list">
        {visible.map((x, i) => (
          <li key={i}>
            <GenericValue value={x} depth={depth + 1} onExplain={onExplain} busy={busy} />
          </li>
        ))}
      </ul>
      {more}
    </>
  );
}

export function GenericValue({ value, depth = 0, onExplain, busy }: Props) {
  if (isPrimitive(value)) return <Primitive v={value} onExplain={onExplain} busy={busy} />;
  if (Array.isArray(value)) return <ListView items={value} depth={depth} onExplain={onExplain} busy={busy} />;
  if (isRec(value)) {
    if (depth >= MAX_DEPTH) return <code>{clip(JSON.stringify(value) ?? '', 200)}</code>;
    const entries = Object.entries(value).filter(([k, v]) => !HIDDEN_KEYS.has(k) && v !== null && v !== undefined && v !== '');
    if (entries.length === 0) return <span className="muted">none</span>;
    return (
      <dl className="dm-dl">
        {entries.map(([k, v]) => (
          <div key={k} className={`dm-row${isPrimitive(v) || isPrimitiveList(v) ? '' : ' stack'}`}>
            <dt>{humanize(k)}</dt>
            <dd>
              <GenericValue value={v} depth={depth + 1} onExplain={onExplain} busy={busy} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="muted">unsupported value</span>;
}
