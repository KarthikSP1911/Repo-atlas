import { parse, plainInline } from '../components/Markdown';

/**
 * Turns the Markdown draft into a PDF file entirely in the browser (nothing is uploaded).
 * The PDF library is loaded only when the button is pressed, so it adds nothing to the first page load.
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

export async function makeGuidePdf(markdown: string, title: string): Promise<Blob> {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableModule.default;

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 54;
  const width = doc.internal.pageSize.getWidth() - margin * 2;
  const bottom = doc.internal.pageSize.getHeight() - margin;
  let y = margin;

  const room = (need: number): void => {
    if (y + need > bottom) {
      doc.addPage();
      y = margin;
    }
  };

  /** Write wrapped text at the current position, moving down as it goes (and across pages). */
  const write = (text: string, opts: { size: number; bold?: boolean; mono?: boolean; indent?: number; color?: number; gap?: number }): void => {
    doc.setFont(opts.mono ? 'courier' : 'helvetica', opts.bold ? 'bold' : 'normal');
    doc.setFontSize(opts.size);
    doc.setTextColor(opts.color ?? 30);
    const lineHeight = opts.size * 1.4;
    const lines = doc.splitTextToSize(pdfSafe(text), width - (opts.indent ?? 0)) as string[];
    for (const line of lines) {
      room(lineHeight);
      doc.text(line, margin + (opts.indent ?? 0), y + opts.size);
      y += lineHeight;
    }
    y += opts.gap ?? 6;
  };

  for (const b of parse(markdown)) {
    switch (b.t) {
      case 'h': {
        const size = b.level === 1 ? 20 : b.level === 2 ? 15 : 12;
        room(size * 2.4);
        y += b.level === 1 ? 0 : 8;
        write(plainInline(b.text), { size, bold: true, gap: b.level <= 2 ? 8 : 4 });
        if (b.level <= 2) {
          doc.setDrawColor(210);
          doc.line(margin, y - 4, margin + width, y - 4);
          y += 4;
        }
        break;
      }
      case 'p':
        write(plainInline(b.text), { size: 10.5 });
        break;
      case 'quote': {
        const start = y;
        for (const l of b.lines) write(plainInline(l), { size: 10, indent: 12, color: 90, gap: 3 });
        doc.setDrawColor(0, 112, 243);
        doc.setLineWidth(2);
        doc.line(margin + 2, start + 2, margin + 2, y - 2);
        doc.setLineWidth(0.5);
        y += 6;
        break;
      }
      case 'ul':
      case 'ol':
        b.items.forEach((item, i) => write(`${b.t === 'ul' ? '-' : `${i + 1}.`} ${plainInline(item)}`, { size: 10.5, indent: 10, gap: 2 }));
        y += 6;
        break;
      case 'code':
        write(b.text, { size: 9, mono: true, indent: 8, gap: 8 });
        break;
      case 'hr':
        room(14);
        doc.setDrawColor(210);
        doc.line(margin, y + 4, margin + width, y + 4);
        y += 14;
        break;
      case 'table':
        room(60);
        autoTable(doc, {
          startY: y,
          margin: { left: margin, right: margin },
          head: [b.head.map((c) => pdfSafe(plainInline(c)))],
          body: b.rows.map((r) => b.head.map((_, i) => pdfSafe(plainInline(r[i] ?? '')))),
          styles: { fontSize: 9, cellPadding: 5, overflow: 'linebreak', textColor: 30 },
          headStyles: { fillColor: [235, 238, 243], textColor: 60, fontStyle: 'bold' },
          theme: 'grid',
        });
        y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 12;
        break;
    }
  }

  doc.setProperties({ title: pdfSafe(title) });
  return doc.output('blob');
}
