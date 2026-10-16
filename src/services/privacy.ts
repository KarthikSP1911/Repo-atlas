/**
 * Privacy helpers shared by the offline engine and the runtime. Snapshots and issue files must not
 * carry email addresses.
 */

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Replace email addresses in free text with a placeholder. Snapshots must not carry emails. */
export function scrubEmails(text: string): string {
  return text.replace(EMAIL_RE, '[email]');
}

/** Some people set their git author name to an email address; keep only the part before the @. */
export function cleanAuthorName(name: string): string {
  const n = name.trim();
  return n.includes('@') ? n.slice(0, n.indexOf('@')).trim() || 'unknown' : n;
}

