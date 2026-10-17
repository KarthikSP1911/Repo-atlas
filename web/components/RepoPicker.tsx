'use client';

import { useId } from 'react';
import { CUSTOM_REPO, REPOS } from './demo-util';

/** The four precomputed repos, plus "Another GitHub repo" with a text box for any public repo URL. */
export function RepoPicker({ value, custom, onChange, label = 'Repo' }: { value: string; custom: string; onChange: (value: string, custom: string) => void; label?: string }) {
  const selectId = useId();
  const inputId = useId();
  return (
    <>
      <label htmlFor={selectId}>{label}</label>
      <select id={selectId} className="dm-input" value={value} onChange={(e) => onChange(e.target.value, custom)}>
        {REPOS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
        <option value={CUSTOM_REPO}>Another GitHub repo…</option>
      </select>
      {value === CUSTOM_REPO && (
        <input
          id={inputId}
          type="text"
          className="dm-input wide mono"
          aria-label="GitHub repo URL or owner/repo"
          placeholder="https://github.com/owner/repo"
          value={custom}
          spellCheck={false}
          autoComplete="off"
          maxLength={300}
          onChange={(e) => onChange(value, e.target.value)}
        />
      )}
    </>
  );
}
