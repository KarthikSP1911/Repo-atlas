'use client';

import { usePathname } from 'next/navigation';
import { GITHUB } from '../lib/config';
import { Icon } from './Icon';
import { Logo } from './Logo';

const LINKS = [
  { href: '/demo/', label: 'Live demo', match: (p: string) => p.startsWith('/demo') },
  { href: '/tools/', label: 'Tool explorer', match: (p: string) => p.startsWith('/tools') },
  { href: '/#how', label: 'How it works', match: () => false },
  { href: '/#tools', label: 'Tools', match: () => false },
  { href: '/#accuracy', label: 'Accuracy', match: () => false },
  { href: '/#connect', label: 'Connect', match: () => false },
] as const;

/** One sticky, blurred bar: brand, links, and the two calls to action. On phones the links drop to a scrolling second row. */
export function SiteHeader() {
  const path = usePathname() ?? '/';
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="nav">
        <div className="container">
          <a className="nav-brand" href="/">
            <Logo size={28} />
            RepoAtlas
          </a>
          <nav className="nav-links" aria-label="Site">
            {LINKS.map((l) => (
              <a key={l.href} className="nav-link" href={l.href} aria-current={l.match(path) ? 'page' : undefined}>
                {l.label}
              </a>
            ))}
          </nav>
          <span className="nav-spacer" />
          <a className="btn btn-sm nav-gh" href={GITHUB} target="_blank" rel="noopener noreferrer">
            <Icon name="fork" size={14} />
            GitHub
          </a>
          <a className="btn btn-sm btn-primary" href="/demo/">
            Try the demo
          </a>
        </div>
      </header>
    </>
  );
}
