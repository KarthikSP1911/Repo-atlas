import type { ReactNode } from 'react';

/** Small stroke icons drawn for this site (16x16, currentColor). Decorative: always aria-hidden. */
const PATHS: Record<string, ReactNode> = {
  check: <path d="M3 8.5l3.2 3.2L13 4.8" />,
  graph: (
    <>
      <circle cx="4" cy="4.5" r="1.8" />
      <circle cx="12" cy="4.5" r="1.8" />
      <circle cx="8" cy="12" r="1.8" />
      <path d="M5.6 5.4l1.7 5M10.4 5.4l-1.7 5M5.8 4.5h4.4" />
    </>
  ),
  book: <path d="M3 3.2c1.8-.5 3.600-.3 5 .8 1.400-1.100 3.200-1.300 5-.8v9c-1.800-.5-3.600-.3-5 .8-1.400-1.100-3.200-1.300-5-.8zM8 4v9" />,
  route: (
    <>
      <circle cx="3.500" cy="12.500" r="1.500" />
      <circle cx="12.500" cy="3.500" r="1.500" />
      <path d="M5 12.500h4a2.500 2.500 0 000-5H7a2.500 2.500 0 010-5h4" />
    </>
  ),
  issue: (
    <>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="1" />
    </>
  ),
  target: (
    <>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
    </>
  ),
  file: <path d="M4 1.500h5l3 3v10H4zM9 1.500v3h3" />,
  shield: <path d="M8 1.500l5.500 2v4.200c0 3.200-2.300 5.600-5.500 6.800C4.800 13.300 2.500 10.900 2.500 7.700V3.500z" />,
  lock: (
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.500" />
      <path d="M5.500 7V5a2.500 2.500 0 015 0v2" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.500V8l2.500 1.500" />
    </>
  ),
  layers: <path d="M8 2L1.500 5.500 8 9l6.500-3.500zM1.500 8.500L8 12l6.500-3.500M1.500 11.500L8 15l6.500-3.500" />,
  play: <path d="M4.500 2.500l8 5.500-8 5.500z" />,
  alert: (
    <>
      <path d="M8 1.500l6.500 12h-13z" />
      <path d="M8 6v3.500M8 11.500v.5" />
    </>
  ),
  fork: (
    <>
      <circle cx="4" cy="3.500" r="1.500" />
      <circle cx="12" cy="3.500" r="1.500" />
      <circle cx="8" cy="12.500" r="1.500" />
      <path d="M4 5v1.500a2 2 0 002 2h4a2 2 0 002-2V5M8 8.500V11" />
    </>
  ),
  export: <path d="M8 10V2M5 5l3-3 3 3M2.500 9v4.500h11V9" />,
  user: (
    <>
      <circle cx="8" cy="5" r="3" />
      <path d="M2.500 14c.5-3 2.800-4.500 5.500-4.500s5 1.500 5.500 4.500" />
    </>
  ),
  copy: (
    <>
      <rect x="5.500" y="5.500" width="8" height="8" rx="1.500" />
      <path d="M10.500 5.500v-2a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name] ?? null}
    </svg>
  );
}
