/**
 * A small streaming tar reader (ustar, pax and GNU long names), enough for GitHub's
 * `tar.gz` archives. Feed it decompressed chunks with push(); it never holds more than the
 * file bodies the caller asked for. Every path is treated as hostile: the first path segment
 * (GitHub's `repo-sha/` folder) is stripped and anything absolute, with `..`, control
 * characters or a very long name is dropped. Symlinks, hard links and devices are ignored.
 */

export type TarDecision = 'buffer' | 'count' | 'skip';

export interface TarFileInfo {
  /** Repo-relative path, forward slashes. */
  path: string;
  size: number;
}

export interface TarFile extends TarFileInfo {
  /** Present when the caller chose 'buffer' and the file is text. */
  text?: string;
  /** Present when the caller chose 'count' and the file is text. */
  lines?: number;
  /** A NUL byte was found near the start: not text, so no text or lines. */
  binary: boolean;
}

export interface TarHandlers {
  /** Called for every regular file before its bytes arrive. */
  decide(info: TarFileInfo): TarDecision;
  /** Called once per file whose decision was not 'skip'. */
  onFile(file: TarFile): void;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarError';
  }
}

const MAX_PATH = 300;
const MAX_META = 64 * 1024;
const BINARY_PROBE = 8000;
const NEWLINE = 0x0a;

type State = 'header' | 'data' | 'pad' | 'end';

/** Safe repo-relative path from a tar entry name, or null. */
export function cleanTarPath(raw: string): string | null {
  const parts = raw.split('/').filter((x) => x !== '');
  if (parts.length < 2) return null; // the top folder itself, or a file outside it
  const rel = parts.slice(1);
  if (rel.some((seg) => seg === '..' || seg === '.')) return null;
  const p = rel.join('/');
  if (p.length > MAX_PATH || /[\u0000-\u001f\\]/.test(p)) return null;
  return p;
}

function cstr(buf: Buffer, from: number, to: number): string {
  const end = buf.indexOf(0, from);
  return buf.toString('utf8', from, end === -1 || end > to ? to : end);
}

function octal(buf: Buffer, from: number, len: number): number {
  if (buf[from] & 0x80) {
    // base-256 size (files over 8 GB): far beyond any limit we allow
    return Number.MAX_SAFE_INTEGER;
  }
  const s = buf.toString('ascii', from, from + len).replace(/\0.*$/, '').trim();
  return s === '' ? 0 : parseInt(s, 8);
}

export class TarParser {
  /** Commit id from GitHub's pax global header, when present. */
  sha: string | undefined;
  /** Regular files seen so far. */
  files = 0;
  /** Decompressed bytes fed so far. */
  bytes = 0;

  private state: State = 'header';
  private readonly hdr = Buffer.alloc(512);
  private hdrLen = 0;
  private zeroBlocks = 0;
  private remaining = 0;
  private pad = 0;

  private kind: 'file' | 'meta-x' | 'meta-g' | 'meta-L' | 'ignore' = 'ignore';
  private decision: TarDecision = 'skip';
  private current: TarFileInfo | null = null;
  private chunks: Buffer[] = [];
  private lines = 0;
  private binary = false;
  private probed = 0;

  private nextPath: string | undefined;
  private nextSize: number | undefined;

  constructor(private readonly handlers: TarHandlers) {}

  get ended(): boolean {
    return this.state === 'end';
  }

  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    let pos = 0;
    while (pos < chunk.length) {
      if (this.state === 'header') {
        const take = Math.min(512 - this.hdrLen, chunk.length - pos);
        chunk.copy(this.hdr, this.hdrLen, pos, pos + take);
        this.hdrLen += take;
        pos += take;
        if (this.hdrLen === 512) {
          this.hdrLen = 0;
          this.onHeader();
        }
      } else if (this.state === 'data') {
        const take = Math.min(this.remaining, chunk.length - pos);
        this.onData(chunk.subarray(pos, pos + take));
        this.remaining -= take;
        pos += take;
        if (this.remaining === 0) this.endData();
      } else if (this.state === 'pad') {
        const take = Math.min(this.pad, chunk.length - pos);
        this.pad -= take;
        pos += take;
        if (this.pad === 0) this.state = 'header';
      } else {
        return;
      }
    }
  }

  private onHeader(): void {
    const h = this.hdr;
    if (h.every((b) => b === 0)) {
      if (++this.zeroBlocks >= 2) this.state = 'end';
      return;
    }
    this.zeroBlocks = 0;

    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw new TarError('Archive is not a valid tar file (bad header checksum).');

    const type = String.fromCharCode(h[156] || 0x30);
    let size = octal(h, 124, 12);
    let name = cstr(h, 0, 100);
    if (h.toString('ascii', 257, 262) === 'ustar') {
      const prefix = cstr(h, 345, 500);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (this.nextPath !== undefined) name = this.nextPath;
    if (this.nextSize !== undefined) size = this.nextSize;

    const meta = type === 'x' ? 'meta-x' : type === 'g' ? 'meta-g' : type === 'L' ? 'meta-L' : null;
    if (meta) {
      if (size > MAX_META) throw new TarError('Archive has an oversized metadata block.');
      this.beginData(meta, size, null, 'buffer');
      return;
    }

    // Per-entry overrides apply to this entry only.
    this.nextPath = undefined;
    this.nextSize = undefined;

    if (type !== '0' && type !== '\0' && type !== '7') {
      // directory, symlink, hard link, device: skip any body
      this.beginData('ignore', size, null, 'skip');
      return;
    }
    const rel = cleanTarPath(name);
    if (rel === null) {
      this.beginData('ignore', size, null, 'skip');
      return;
    }
    this.files++;
    const info: TarFileInfo = { path: rel, size };
    this.beginData('file', size, info, this.handlers.decide(info));
  }

  private beginData(kind: TarParser['kind'], size: number, info: TarFileInfo | null, decision: TarDecision): void {
    this.kind = kind;
    this.current = info;
    this.decision = decision;
    this.remaining = size;
    this.pad = (512 - (size % 512)) % 512;
    this.chunks = [];
    this.lines = 0;
    this.binary = false;
    this.probed = 0;
    if (size === 0) this.endData();
    else this.state = 'data';
  }

  private onData(part: Buffer): void {
    if (this.decision === 'skip') return;
    if (this.decision === 'buffer') {
      this.chunks.push(Buffer.from(part)); // copy: do not pin the whole 64 KB decompression chunk
      if (this.probed < BINARY_PROBE && !this.binary) this.probe(part);
      return;
    }
    // 'count': lines only, no storage
    if (!this.binary && this.probed < BINARY_PROBE) this.probe(part);
    if (this.binary) return;
    for (let i = 0; i < part.length; i++) if (part[i] === NEWLINE) this.lines++;
    this.lastByte = part.length > 0 ? part[part.length - 1] : this.lastByte;
  }

  private lastByte = NEWLINE;

  private probe(part: Buffer): void {
    const n = Math.min(part.length, BINARY_PROBE - this.probed);
    if (part.subarray(0, n).includes(0)) this.binary = true;
    this.probed += n;
  }

  private endData(): void {
    const kind = this.kind;
    const body = this.decision === 'buffer' ? Buffer.concat(this.chunks) : null;
    this.chunks = [];

    if (kind === 'meta-x' || kind === 'meta-g') {
      this.readPax(body?.toString('utf8') ?? '', kind === 'meta-g');
    } else if (kind === 'meta-L') {
      this.nextPath = body ? body.toString('utf8').replace(/\0.*$/, '') : undefined;
    } else if (kind === 'file' && this.current && this.decision !== 'skip') {
      const info = this.current;
      if (this.binary) {
        this.handlers.onFile({ ...info, binary: true });
      } else if (body) {
        const text = body.toString('utf8');
        this.handlers.onFile({ ...info, text, binary: false });
      } else {
        // a final line without a newline still counts as a line
        const lines = info.size > 0 && this.lastByte !== NEWLINE ? this.lines + 1 : this.lines;
        this.handlers.onFile({ ...info, lines, binary: false });
      }
    }
    this.lastByte = NEWLINE;
    this.current = null;
    this.state = this.pad > 0 ? 'pad' : 'header';
  }

  private readPax(text: string, global: boolean): void {
    let i = 0;
    while (i < text.length) {
      const sp = text.indexOf(' ', i);
      if (sp === -1) break;
      const len = parseInt(text.slice(i, sp), 10);
      if (!Number.isFinite(len) || len <= 0) break;
      const record = text.slice(sp + 1, i + len - 1); // drop the trailing newline
      const eq = record.indexOf('=');
      if (eq > 0) {
        const key = record.slice(0, eq);
        const value = record.slice(eq + 1);
        if (global && key === 'comment' && /^[0-9a-f]{40}$/.test(value)) this.sha = value;
        if (!global && key === 'path') this.nextPath = value;
        if (!global && key === 'size' && /^\d+$/.test(value)) this.nextSize = Number(value);
      }
      i += len;
    }
  }
}
