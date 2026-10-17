import type { ReactNode } from 'react';

/**
 * A small Markdown renderer for the guide drafts and excerpts the server returns.
 *
 * It handles what those drafts contain: headings, paragraphs, block quotes, bullet and numbered
 * lists, tables, fenced code, horizontal rules, and inline code, bold, italic and links.
 * The text comes from untrusted repo data, so everything is built as React elements (never as
 * raw HTML), and links are only made for http(s) addresses.
 */

export type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'quote'; lines: string[] }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'code'; text: string }
  | { t: 'hr' };

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

const isSeparator = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const isTableRow = (line: string): boolean => line.trim().startsWith('|');

export function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (a missing one just ends the block at the end of the text)
      out.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push({ t: 'quote', lines: body });
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push({ t: 'table', head, rows });
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      out.push({ t: 'ul', items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      out.push({ t: 'ol', items });
      continue;
    }
    // A paragraph runs until a blank line or the start of another block.
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6}\s|\s*```|\s*>|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i]) &&
      !(isTableRow(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1]))
    ) {
      body.push(lines[i++].trim());
    }
    if (body.length === 0) {
      body.push(lines[i++].trim());
    }
    out.push({ t: 'p', text: body.join(' ') });
  }
  return out;
}

const INLINE = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    const key = `${keyBase}-${n++}`;
    if (m[2] !== undefined) nodes.push(<code key={key}>{m[2]}</code>);
    else if (m[3] !== undefined) nodes.push(<strong key={key}>{m[3]}</strong>);
    else if (m[4] !== undefined) nodes.push(<em key={key}>{m[4]}</em>);
    else
      nodes.push(
        <a key={key} href={m[6]} target="_blank" rel="noopener noreferrer nofollow">
          {m[5]}
        </a>,
      );
    last = at + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export interface Run {
  text: string;
  kind: 'plain' | 'code' | 'bold' | 'em' | 'link';
}

/** The inline syntax as styled pieces, for renderers other than React (the PDF). */
export function inlineRuns(text: string): Run[] {
  const runs: Run[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) runs.push({ text: text.slice(last, at), kind: 'plain' });
    if (m[2] !== undefined) runs.push({ text: m[2], kind: 'code' });
    else if (m[3] !== undefined) runs.push({ text: m[3], kind: 'bold' });
    else if (m[4] !== undefined) runs.push({ text: m[4], kind: 'em' });
    else runs.push({ text: m[5], kind: 'link' });
    last = at + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), kind: 'plain' });
  return runs;
}

/** The same inline syntax with the markers removed, for places that cannot show formatting (the PDF). */
export function plainInline(text: string): string {
  return text.replace(INLINE, (_m, _ticks, code, bold, italic, label) => code ?? bold ?? italic ?? label ?? '');
}

/** True when text is long enough and shaped like Markdown (headings, lists, tables or quotes on their own lines). */
export function looksLikeMarkdown(text: string): boolean {
  return text.length > 60 && text.includes('\n') && /^(#{1,6}\s|>\s?|\s*[-*]\s|\s*\d+[.)]\s|\|.+\||```)/m.test(text);
}

export function Markdown({ text }: { text: string }) {
  const blocks = parse(text);
  return (
    <div className="dm-md" tabIndex={0} role="region" aria-label="Formatted text">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.t) {
          case 'h': {
            const Tag = (`h${Math.min(6, b.level + 1)}` as 'h2');
            return (
              <Tag key={k} className={`md-h md-h${b.level}`}>
                {inline(b.text, k)}
              </Tag>
            );
          }
          case 'p':
            return <p key={k}>{inline(b.text, k)}</p>;
          case 'quote':
            return (
              <blockquote key={k}>
                {b.lines.map((l, j) => (
                  <p key={j}>{inline(l, `${k}-${j}`)}</p>
                ))}
              </blockquote>
            );
          case 'ul':
            return (
              <ul key={k}>
                {b.items.map((l, j) => (
                  <li key={j}>{inline(l, `${k}-${j}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={k}>
                {b.items.map((l, j) => (
                  <li key={j}>{inline(l, `${k}-${j}`)}</li>
                ))}
              </ol>
            );
          case 'table':
            return (
              <div key={k} className="dm-tablewrap">
                <table className="dm-table md-table">
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} scope="col">
                          {inline(c, `${k}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {b.head.map((_, c) => (
                          <td key={c}>{inline(r[c] ?? '', `${k}-${j}-${c}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'code':
            return (
              <pre key={k} className="md-code">
                <code>{b.text}</code>
              </pre>
            );
          case 'hr':
            return <hr key={k} />;
        }
      })}
    </div>
  );
}
