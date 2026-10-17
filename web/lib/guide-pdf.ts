import { inlineRuns, parse, plainInline, type Run } from '../components/Markdown';

/**
 * Turns the Markdown draft into a PDF file entirely in the browser (nothing is uploaded).
 * The PDF library is loaded only when the button is pressed, so it adds nothing to the first page load.
 *
 * Layout: a title band, a short callout for the draft's warning, blue section headings, real bullets
 * with hanging indents, file paths and commands in a monospace font, tables with a shaded header,
 * and "Page x of y" in the footer.
 *
 * The standard PDF fonts only cover Western European characters, so a few common symbols are
 * swapped for plain look-alikes and anything else outside that range becomes "?".
 */

const SWAPS: Record<string, string> = { '→': '->', '←': '<-', '…': '...', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '•': '-', '✓': 'ok', ' ': ' ' };

export function pdfSafe(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (SWAPS[ch]) out += SWAPS[ch];
    else if (code === 10 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255)) out += ch;
    else out += '?';
  }
  return out;
}

type RGB = [number, number, number];
const INK: RGB = [24, 28, 36];
const MUTED: RGB = [96, 105, 118];
const ACCENT: RGB = [0, 98, 220];
const RULE: RGB = [221, 225, 231];
const BAND: RGB = [14, 18, 26];
const CODE_BG: RGB = [238, 241, 246];
const CODE_INK: RGB = [20, 60, 120];
const CALLOUT_BG: RGB = [240, 245, 255];

interface Piece {
  text: string;
  mono: boolean;
  bold: boolean;
  italic: boolean;
}
interface Line {
  pieces: Piece[];
  width: number;
}

export async function makeGuidePdf(markdown: string, title: string): Promise<Blob> {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableModule.default;

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 54;
  const width = pageW - margin * 2;
  const bottom = pageH - 60;
  let y = margin;

  const color = (c: RGB): void => {
    doc.setTextColor(c[0], c[1], c[2]);
  };
  const fill = (c: RGB): void => {
    doc.setFillColor(c[0], c[1], c[2]);
  };
  const stroke = (c: RGB): void => {
    doc.setDrawColor(c[0], c[1], c[2]);
  };

  const room = (need: number): void => {
    if (y + need > bottom) {
      doc.addPage();
      y = margin;
    }
  };

  const setFont = (p: Pick<Piece, 'mono' | 'bold' | 'italic'>, size: number): void => {
    doc.setFont(p.mono ? 'courier' : 'helvetica', p.bold ? 'bold' : p.italic ? 'italic' : 'normal');
    doc.setFontSize(p.mono ? size - 0.8 : size);
  };

  const measure = (text: string, p: Pick<Piece, 'mono' | 'bold' | 'italic'>, size: number): number => {
    setFont(p, size);
    // code chips get 3pt of breathing room (1.5pt each side) so they do not touch the words around them
    return doc.getTextWidth(text) + (p.mono && text.trim() ? 3 : 0);
  };

  /** Break styled runs into lines that fit; very long words (file paths) are split at slashes or by length. */
  const layout = (runs: Run[], size: number, maxW: number, base: Partial<Piece> = {}): Line[] => {
    const lines: Line[] = [];
    let cur: Line = { pieces: [], width: 0 };
    const push = (text: string, p: Piece): void => {
      const w = measure(text, p, size);
      const last = cur.pieces[cur.pieces.length - 1];
      if (last && last.mono === p.mono && last.bold === p.bold && last.italic === p.italic) last.text += text;
      else cur.pieces.push({ ...p, text });
      cur.width += w;
    };
    const wrap = (): void => {
      // drop a trailing space so right edges line up
      const last = cur.pieces[cur.pieces.length - 1];
      if (last && last.text.endsWith(' ')) {
        last.text = last.text.trimEnd();
        cur.width = cur.pieces.reduce((s, q) => s + measure(q.text, q, size), 0);
      }
      lines.push(cur);
      cur = { pieces: [], width: 0 };
    };
    for (const r of runs) {
      const p: Piece = { text: '', mono: r.kind === 'code' || !!base.mono, bold: r.kind === 'bold' || !!base.bold, italic: r.kind === 'em' || !!base.italic };
      for (const word of pdfSafe(r.text).split(/(?<= )/)) {
        let rest = word;
        while (rest) {
          const w = measure(rest, p, size);
          if (cur.width + w <= maxW || (cur.pieces.length === 0 && w <= maxW)) {
            push(rest, p);
            rest = '';
          } else if (cur.pieces.length > 0 && w <= maxW) {
            wrap();
          } else {
            // longer than a whole line: cut at the last slash that fits, else at the character that fits
            let cut = rest.length;
            while (cut > 1 && cur.width + measure(rest.slice(0, cut), p, size) > maxW) cut--;
            const slash = rest.lastIndexOf('/', cut - 1);
            if (slash > 0) cut = slash + 1;
            if (cur.pieces.length > 0 && cut <= 1) {
              wrap();
              continue;
            }
            push(rest.slice(0, cut), p);
            rest = rest.slice(cut);
            if (rest) wrap();
          }
        }
      }
    }
    if (cur.pieces.length) wrap();
    return lines;
  };

  const draw = (lines: Line[], x: number, size: number, c: RGB, lineH: number): void => {
    for (const line of lines) {
      room(lineH);
      let cx = x;
      for (const p of line.pieces) {
        const w = measure(p.text, p, size);
        const chip = p.mono && p.text.trim().length > 0;
        if (chip) {
          fill(CODE_BG);
          doc.roundedRect(cx, y + 1, w, size + 2.5, 2, 2, 'F');
        }
        setFont(p, size);
        color(p.mono ? CODE_INK : c);
        doc.text(p.text, cx + (chip ? 1.5 : 0), y + size);
        cx += w;
      }
      y += lineH;
    }
  };

  const paragraph = (text: string, opts: { size?: number; x?: number; maxW?: number; c?: RGB; gap?: number; base?: Partial<Piece> } = {}): void => {
    const size = opts.size ?? 10.5;
    const x = opts.x ?? margin;
    draw(layout(inlineRuns(text), size, opts.maxW ?? width - (x - margin), opts.base), x, size, opts.c ?? INK, size * 1.5);
    y += opts.gap ?? 6;
  };

  const blocks = parse(markdown);
  let i = 0;

  // Title band: the first heading becomes a header at the top of page 1.
  if (blocks[0]?.t === 'h' && blocks[0].level === 1) {
    const h = blocks[0];
    const titleLines = layout([{ text: h.text, kind: 'plain' }], 22, width, { bold: true });
    const bandH = 54 + titleLines.length * 28 + 22;
    fill(BAND);
    doc.rect(0, 0, pageW, bandH, 'F');
    fill(ACCENT);
    doc.rect(0, bandH, pageW, 3, 'F');
    y = 34;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(150, 165, 190);
    doc.text('ARCHITECTURE GUIDE  -  DRAFT', margin, y + 9);
    y += 22;
    for (const l of titleLines) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(22);
      doc.setTextColor(255, 255, 255);
      doc.text(l.pieces.map((p) => p.text).join(''), margin, y + 22);
      y += 28;
    }
    y = bandH + 24;
    i = 1;
  }

  for (; i < blocks.length; i++) {
    const b = blocks[i];
    switch (b.t) {
      case 'h': {
        const h2 = b.level <= 2;
        room(h2 ? 140 : 70); // keep a heading together with the start of what it introduces
        y += h2 ? 12 : 8;
        const size = h2 ? 15 : 12;
        const lines = layout([{ text: b.text, kind: 'plain' }], size, width, { bold: true });
        draw(lines, margin, size, h2 ? INK : INK, size * 1.35);
        if (h2) {
          stroke(RULE);
          doc.setLineWidth(0.6);
          doc.line(margin, y + 2, margin + width, y + 2);
          fill(ACCENT);
          doc.rect(margin, y + 1, 34, 2.2, 'F');
          y += 10;
        } else y += 4;
        break;
      }
      case 'p':
        paragraph(b.text);
        break;
      case 'quote': {
        const size = 10;
        const pad = 9;
        const lines = b.lines.flatMap((l) => layout(inlineRuns(l), size, width - pad * 2 - 6));
        const lineH = size * 1.5;
        const boxH = lines.length * lineH + pad * 2 - 2;
        room(boxH + 8);
        fill(CALLOUT_BG);
        doc.roundedRect(margin, y, width, boxH, 3, 3, 'F');
        fill(ACCENT);
        doc.rect(margin, y, 3, boxH, 'F');
        const top = y;
        y += pad - 1;
        const startPage = doc.getCurrentPageInfo().pageNumber;
        draw(lines, margin + pad + 4, size, MUTED, lineH);
        if (doc.getCurrentPageInfo().pageNumber !== startPage) y += 0; // a callout this small never splits in practice
        y = Math.max(y, top + boxH) + 10;
        break;
      }
      case 'ul':
      case 'ol': {
        const size = 10.5;
        const indent = 16;
        b.items.forEach((item, n) => {
          const lines = layout(inlineRuns(item), size, width - indent);
          room(size * 1.5);
          if (b.t === 'ul') {
            fill(ACCENT);
            doc.circle(margin + 5, y + size * 0.62, 1.7, 'F');
          } else {
            setFont({ mono: false, bold: true, italic: false }, size);
            color(ACCENT);
            doc.text(`${n + 1}.`, margin, y + size);
          }
          draw(lines, margin + indent, size, INK, size * 1.5);
          y += 2;
        });
        y += 6;
        break;
      }
      case 'code': {
        const size = 9;
        const lines = b.text.split('\n').flatMap((l) => layout([{ text: l || ' ', kind: 'plain' }], size, width - 20, { mono: true }));
        const boxH = lines.length * size * 1.45 + 14;
        room(Math.min(boxH, 200));
        fill(CODE_BG);
        doc.roundedRect(margin, y, width, boxH, 3, 3, 'F');
        y += 7;
        draw(lines, margin + 10, size, CODE_INK, size * 1.45);
        y += 12;
        break;
      }
      case 'hr':
        room(14);
        stroke(RULE);
        doc.line(margin, y + 4, margin + width, y + 4);
        y += 14;
        break;
      case 'table': {
        const rows = b.rows.map((r) => b.head.map((_, c) => r[c] ?? ''));
        room(70);
        autoTable(doc, {
          startY: y,
          margin: { left: margin, right: margin, bottom: 60 },
          head: [b.head.map((c) => pdfSafe(plainInline(c)))],
          body: rows.map((r) => r.map((c) => pdfSafe(plainInline(c)))),
          theme: 'plain',
          styles: { font: 'helvetica', fontSize: 9, cellPadding: { top: 5, bottom: 5, left: 7, right: 7 }, overflow: 'linebreak', textColor: INK, lineColor: RULE, lineWidth: { bottom: 0.5 } },
          headStyles: { fillColor: [232, 238, 248], textColor: [40, 60, 100], fontStyle: 'bold', fontSize: 8.5, lineWidth: 0 },
          alternateRowStyles: { fillColor: [249, 250, 252] },
          didParseCell: (d) => {
            // a cell made only of a code span (a file path or a command) is shown in monospace
            if (d.section === 'body' && /^`[^`]+`$/.test((rows[d.row.index]?.[d.column.index] ?? '').trim())) {
              d.cell.styles.font = 'courier';
              d.cell.styles.fontSize = 8.2;
              d.cell.styles.textColor = CODE_INK;
            }
          },
        });
        y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 14;
        break;
      }
    }
  }

  // footer on every page
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    stroke(RULE);
    doc.setLineWidth(0.5);
    doc.line(margin, pageH - 42, pageW - margin, pageH - 42);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    doc.text('Generated by RepoAtlas from static analysis and git history. Verify before relying on it.', margin, pageH - 28);
    doc.text(`Page ${p} of ${pages}`, pageW - margin, pageH - 28, { align: 'right' });
  }

  doc.setProperties({ title: pdfSafe(title), subject: 'Architecture guide draft', creator: 'RepoAtlas' });
  return doc.output('blob');
}
