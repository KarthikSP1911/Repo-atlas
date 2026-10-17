/** The RepoAtlas mark: three linked nodes in a rounded square. Black on light, white on dark (follows the text colour). Same drawing as public/favicon.svg. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--fg)" />
      <path d="M10.500 11.500l5.500 10M21.500 11.500l-5.500 10M10.500 11h11" stroke="var(--canvas)" strokeWidth="2" strokeLinecap="round" fill="none" />
      <circle cx="10.500" cy="11" r="3" fill="var(--canvas)" />
      <circle cx="21.500" cy="11" r="3" fill="var(--canvas)" />
      <circle cx="16" cy="22" r="3" fill="var(--canvas)" />
    </svg>
  );
}
