'use client';

import { useState } from 'react';
import { Icon } from './Icon';

/** Copies text to the clipboard and says so; if the browser blocks it, it says that instead. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'blocked'>('idle');
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('blocked');
    }
    window.setTimeout(() => setState('idle'), 2000);
  };
  return (
    <button type="button" className="btn btn-sm" onClick={() => void copy()} aria-live="polite">
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={14} />
      {state === 'copied' ? 'Copied' : state === 'blocked' ? 'Select and copy' : label}
    </button>
  );
}

/** A code block with a copy button. */
export function CodeBlock({ text, label }: { text: string; label?: string }) {
  return (
    <div className="codeblock">
      <pre tabIndex={0} aria-label={label}>
        <code style={{ background: 'none', padding: 0, fontSize: 'inherit' }}>{text}</code>
      </pre>
      <CopyButton text={text} />
    </div>
  );
}
