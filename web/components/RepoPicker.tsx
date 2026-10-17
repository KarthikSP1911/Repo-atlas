'use client';

import { useId } from 'react';
import { CUSTOM_REPO, REPOS } from './demo-util';
import { Select } from './Select';

/** The four precomputed repos, plus "Another GitHub repo" with a text box for any public repo URL. */
export function RepoPicker({ value, custom, onChange, label = 'Repo', error = null }: { value: string; custom: string; onChange: (value: string, custom: string) => void; label?: string; error?: string | null }) {
  const selectId = useId();
  const inputId = useId();
  return (
    <>
      <label htmlFor={selectId}>{label}</label>
      <Select
        id={selectId}
        value={value}
        onChange={(v) => onChange(v, custom)}
        options={[...REPOS.map((r) => ({ value: r.value, label: r.label })), { value: CUSTOM_REPO, label: 'Another GitHub repo…' }]}
      />
      {value === CUSTOM_REPO && (
        <input
          id={inputId}
          type="text"
          className="dm-input wide mono"
          aria-label="GitHub repo URL or owner/repo"
          aria-invalid={error ? true : undefined}
          placeholder="https://github.com/owner/repo"
          value={custom}
          spellCheck={false}
          autoComplete="off"
          maxLength={300}
          onChange={(e) => onChange(value, e.target.value)}
        />
      )}
      {error && (
        <span className="tx-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
