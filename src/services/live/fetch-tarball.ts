import * as zlib from 'node:zlib';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { TarParser, TarError, type TarHandlers } from './tar.js';
import type { RepoSpec } from './repo-spec.js';

/**
 * Downloads a public repo as a tar.gz from codeload.github.com. That host is not part of the
 * GitHub API, so it needs no token and has no API rate limit. The download is streamed and
 * stopped, not failed, when a limit is reached: the caller gets the files read so far and a
 * `truncated` reason.
 */

export class LiveBuildError extends Error {
  constructor(
    public readonly code: 'bad_ref' | 'not_found' | 'rate_limited' | 'busy' | 'disabled' | 'upstream' | 'too_big' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'LiveBuildError';
  }
}

export interface TarballLimits {
  /** Stop reading after this many compressed bytes downloaded. */
  maxCompressedBytes: number;
  /** Stop after this many decompressed bytes (guards against decompression bombs). */
  maxUncompressedBytes: number;
  /** Stop after this many archive entries. */
  maxEntries: number;
  /** Stop reading at this wall-clock time (ms since epoch). */
  deadlineAt: number;
}

export const DEFAULT_TARBALL_LIMITS = {
  maxCompressedBytes: 80 * 1024 * 1024,
  maxUncompressedBytes: 700 * 1024 * 1024,
  maxEntries: 120_000,
} as const;

export interface TarballOutcome {
  /** Commit id from the archive, when GitHub included it. */
  sha: string | undefined;
  /** Regular files seen (before any filtering). */
  filesSeen: number;
  truncated: boolean;
  truncatedReason: string | undefined;
  compressedBytes: number;
  uncompressedBytes: number;
}

const ALLOWED_HOST = 'codeload.github.com';
const API_HOST = 'api.github.com';
const MAX_REDIRECTS = 3;

export function tarballUrl(spec: RepoSpec, ref = 'HEAD'): string {
  return `https://${ALLOWED_HOST}/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.name)}/tar.gz/${encodeURIComponent(ref)}`;
}

/** The authenticated route to the same archive; it redirects to a signed codeload URL. */
export function apiTarballUrl(spec: RepoSpec): string {
  return `https://${API_HOST}/repos/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.name)}/tarball`;
}

/**
 * Follows redirects by hand so every hop can be checked: the first hop may be api.github.com
 * (only when a token is given, and only that hop carries it); every later hop must be
 * codeload.github.com and carries no credentials.
 */
async function openTarball(url: string, fetchFn: typeof fetch, signal: AbortSignal, token?: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = new URL(current).host;
    const apiHop = hop === 0 && host === API_HOST && token !== undefined;
    if (host !== ALLOWED_HOST && !apiHop) throw new LiveBuildError('upstream', 'GitHub redirected the download to an unexpected host, so it was refused.');
    const headers: Record<string, string> = { 'user-agent': 'repoatlas', accept: apiHop ? 'application/vnd.github+json' : 'application/gzip' };
    if (apiHop) headers.authorization = `Bearer ${token}`;
    const res = await fetchFn(current, { redirect: 'manual', headers, signal });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!loc) throw new LiveBuildError('upstream', 'GitHub sent a redirect without a location.');
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new LiveBuildError('upstream', 'GitHub redirected the download too many times.');
}

export async function readTarball(spec: RepoSpec, handlers: TarHandlers, limits: TarballLimits, fetchFn: typeof fetch = fetch, token?: string): Promise<TarballOutcome> {
  const controller = new AbortController();
  const wait = Math.max(1000, limits.deadlineAt - Date.now() + 5000);
  const timer = setTimeout(() => controller.abort(), wait);
  try {
    const open = async (url: string, tok?: string): Promise<Response> => {
      try {
        return await openTarball(url, fetchFn, controller.signal, tok);
      } catch (e) {
        if (e instanceof LiveBuildError) throw e;
        throw new LiveBuildError('upstream', 'Could not reach GitHub to download the repo. Try again in a moment.');
      }
    };
    const refused = (r: Response): boolean => r.status === 403 || r.status === 429;
    let res: Response | undefined;
    if (token) {
      // The authenticated route is not subject to the anonymous per-address limit on codeload.
      const viaApi = await open(apiTarballUrl(spec), token).catch(() => undefined);
      if (viaApi && viaApi.ok && viaApi.body) res = viaApi;
      else if (viaApi?.status === 404) res = viaApi;
      else await viaApi?.body?.cancel().catch(() => undefined);
    }
    if (!res) res = await open(tarballUrl(spec));
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      throw new LiveBuildError('not_found', `GitHub has no public repo ${spec.repo}. Check the spelling; private repos are not supported.`);
    }
    if (refused(res)) {
      await res.body?.cancel().catch(() => undefined);
      throw new LiveBuildError(
        'rate_limited',
        `GitHub is rate-limiting downloads from this server's network right now.${token ? '' : ' (A GitHub token on the server avoids this.)'} Try again in a few minutes, or use one of the precomputed repos.`,
      );
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new LiveBuildError('upstream', `GitHub answered the download with HTTP ${res.status}.`);
    }

    const parser = new TarParser(handlers);
    const source = Readable.fromWeb(res.body as unknown as NodeWebStream);
    let compressed = 0;
    source.on('data', (c: Buffer) => {
      compressed += c.length;
    });
    const gunzip = zlib.createGunzip();
    source.on('error', (e) => gunzip.destroy(e));
    source.pipe(gunzip);

    let truncatedReason: string | undefined;
    try {
      for await (const chunk of gunzip as AsyncIterable<Buffer>) {
        parser.push(chunk);
        if (parser.ended) break;
        if (compressed > limits.maxCompressedBytes) truncatedReason = `the download passed ${Math.round(limits.maxCompressedBytes / 1048576)} MB`;
        else if (parser.bytes > limits.maxUncompressedBytes) truncatedReason = `the repo expands past ${Math.round(limits.maxUncompressedBytes / 1048576)} MB`;
        else if (parser.files > limits.maxEntries) truncatedReason = `the repo has more than ${limits.maxEntries.toLocaleString('en-US')} files`;
        else if (Date.now() > limits.deadlineAt) truncatedReason = 'reading took longer than the time limit';
        if (truncatedReason) break;
      }
    } catch (e) {
      if (controller.signal.aborted) {
        truncatedReason = 'reading took longer than the time limit';
      } else if (e instanceof TarError) {
        throw new LiveBuildError('upstream', e.message);
      } else if (!truncatedReason) {
        throw new LiveBuildError('upstream', 'The download from GitHub was cut off or damaged. Try again.');
      }
    } finally {
      source.destroy();
      gunzip.destroy();
    }

    return {
      sha: parser.sha,
      filesSeen: parser.files,
      truncated: truncatedReason !== undefined,
      truncatedReason,
      compressedBytes: compressed,
      uncompressedBytes: parser.bytes,
    };
  } finally {
    clearTimeout(timer);
  }
}
