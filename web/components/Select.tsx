'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface SelectOption {
  value: string;
  /** "Title: description" shows the title in the box and both lines in the list. */
  label: string;
}

/** Split "Title: longer description" at the first colon-space. */
function parts(label: string): { title: string; desc?: string } {
  const i = label.indexOf(': ');
  return i > 0 ? { title: label.slice(0, i), desc: label.slice(i + 2) } : { title: label };
}

/**
 * A styled dropdown that replaces the browser's own <select>, so it matches the site in light and
 * dark mode. It follows the WAI-ARIA combobox/listbox pattern: arrow keys, Home and End, Enter or
 * Space to choose, Escape to close, type a letter to jump, click outside to close. Use it with
 * a <label htmlFor={id}> like any form control.
 */
export function Select({
  id,
  value,
  options,
  onChange,
  invalid,
  disabled,
  describedBy,
}: {
  id?: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
}) {
  const auto = useId();
  const triggerId = id ?? `${auto}-btn`;
  const listId = `${auto}-list`;
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const [active, setActive] = useState(selectedIndex);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const selected = options[selectedIndex];

  const shown = useMemo(() => (selected ? parts(selected.label).title : ''), [selected]);

  // Close when the user clicks or tabs away.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  // Keep the highlighted option in view by scrolling the list itself (never the page).
  useEffect(() => {
    const l = list.current;
    const el = l?.children[active] as HTMLElement | undefined;
    if (!open || !l || !el) return;
    if (el.offsetTop < l.scrollTop) l.scrollTop = Math.max(0, el.offsetTop - 6);
    else if (el.offsetTop + el.offsetHeight > l.scrollTop + l.clientHeight) l.scrollTop = el.offsetTop + el.offsetHeight - l.clientHeight + 6;
  }, [open, active]);

  const openList = (): void => {
    setActive(selectedIndex);
    setOpen(true);
  };
  const choose = (i: number): void => {
    const o = options[i];
    if (o) onChange(o.value);
    setOpen(false);
    (document.getElementById(triggerId) as HTMLElement | null)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (disabled) return;
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) openList();
        else setActive((a) => Math.min(last, a + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) openList();
        else setActive((a) => Math.max(0, a - 1));
        break;
      case 'Home':
        if (open) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case 'End':
        if (open) {
          e.preventDefault();
          setActive(last);
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (open) choose(active);
        else openList();
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now();
          typed.current.text = now - typed.current.at > 700 ? e.key.toLowerCase() : typed.current.text + e.key.toLowerCase();
          typed.current.at = now;
          const hit = options.findIndex((o) => o.label.toLowerCase().replace(/^\d+\.\s*/, '').startsWith(typed.current.text));
          if (hit >= 0) {
            if (!open) openList();
            setActive(hit);
          }
        }
    }
  };

  return (
    <div className={`sel${open ? ' open' : ''}${disabled ? ' disabled' : ''}`} ref={root}>
      <button
        type="button"
        id={triggerId}
        className="sel-btn dm-input"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="sel-value">{shown}</span>
        <span className="sel-chev" aria-hidden="true">
          <Icon name="chevron" size={14} />
        </span>
      </button>
      {open && (
        <ul className="sel-list" id={listId} role="listbox" ref={list} tabIndex={-1}>
          {options.map((o, i) => {
            const p = parts(o.label);
            return (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={o.value === value}
                className={`sel-opt${i === active ? ' active' : ''}`}
                onMouseMove={() => active !== i && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
              >
                <span className="sel-opt-text">
                  <span className="sel-opt-title">{p.title}</span>
                  {p.desc && <span className="sel-opt-desc">{p.desc}</span>}
                </span>
                {o.value === value && (
                  <span className="sel-opt-check" aria-hidden="true">
                    <Icon name="check" size={14} />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
