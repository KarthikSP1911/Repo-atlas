import * as zlib from 'node:zlib';

/** Builds small tar archives in memory for the live-build tests. */

export function tarHeader(name: string, size: number, type = '0', prefix = ''): Buffer {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100, 'utf8');
  b.write('0000644\0', 100);
  b.write('0000000\0', 108);
  b.write('0000000\0', 116);
  b.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  b.write('00000000000\0', 136);
  b.write('        ', 148);
  b.write(type, 156);
  b.write('ustar\0', 257);
  b.write('00', 263);
  if (prefix) b.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const x of b) sum += x;
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return b;
}

export function tarEntry(name: string, content: string | Buffer = '', type = '0', prefix = ''): Buffer {
  const data = Buffer.from(content);
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([tarHeader(name, data.length, type, prefix), data, Buffer.alloc(pad)]);
}

/** A pax extended header entry ('x' for the next entry, 'g' for the whole archive). */
export function paxEntry(records: Record<string, string>, global = false): Buffer {
  let body = '';
  for (const [k, v] of Object.entries(records)) {
    const rest = ` ${k}=${v}\n`;
    let len = rest.length + 1;
    while (`${len}${rest}`.length !== len) len = `${len}${rest}`.length;
    body += `${len}${rest}`;
  }
  return tarEntry(global ? 'pax_global_header' : 'PaxHeader/entry', body, global ? 'g' : 'x');
}

/** GitHub-style archive: a global header with the commit id, then entries under `repo-<sha>/`. */
export function githubTar(files: Record<string, string | Buffer>, sha = 'a'.repeat(40), top = 'repo-HEAD'): Buffer {
  const parts: Buffer[] = [paxEntry({ comment: sha }, true), tarEntry(`${top}/`, '', '5')];
  for (const [p, c] of Object.entries(files)) parts.push(tarEntry(`${top}/${p}`, c));
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const gz = (b: Buffer): Buffer => zlib.gzipSync(b);

/** A fetch that answers from a table of URL prefix -> response maker. */
export type Route = (url: string) => Response | Promise<Response>;
export function fakeFetch(routes: Record<string, Route>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response('not routed', { status: 599 });
    return routes[key](url);
  }) as typeof fetch;
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

export const tgz = (b: Buffer, status = 200): Response => new Response(new Uint8Array(gz(b)), { status, headers: { 'content-type': 'application/gzip' } });
