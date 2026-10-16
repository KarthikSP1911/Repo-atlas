import { ToolDecorator as Tool, z, ExecutionContext, Injectable } from '@nitrostack/core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * TEMPORARY (Phase 1 deployment spike). Deleted once docs/SPIKE.md is written.
 *
 * Reports what the hosting platform allows: git, disk, network, memory, port and
 * transport. It never returns token values or full environment dumps; env vars
 * are reported by name and as booleans only.
 */

const MARKER_DIR = path.join(process.cwd(), '.probe');
const MARKER_FILE = path.join(MARKER_DIR, 'marker.json');

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - t0, value };
  } catch (e) {
    return { ms: Date.now() - t0, error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) };
  }
}

async function probeHttps(url: string) {
  const r = await timed(async () => {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'repoatlas-env-probe', Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    return {
      status: res.status,
      rateLimitLimit: res.headers.get('x-ratelimit-limit'),
      rateLimitRemaining: res.headers.get('x-ratelimit-remaining'),
    };
  });
  return { url, ok: r.error === undefined, ms: r.ms, ...(r.value ?? {}), error: r.error };
}

function probeDisk(dir: string) {
  const file = path.join(dir, `.probe-write-${process.pid}.txt`);
  const payload = `probe-${Date.now()}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, payload);
    const back = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    return { dir, writable: true, readBackMatches: back === payload };
  } catch (e) {
    return { dir, writable: false, readBackMatches: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/** First call writes a marker; later calls (after a restart or redeploy) show whether it survived. */
function probePersistence() {
  try {
    fs.mkdirSync(MARKER_DIR, { recursive: true });
    const now = new Date().toISOString();
    if (fs.existsSync(MARKER_FILE)) {
      const prev = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8')) as { firstWrittenAt: string; bootId: string };
      return {
        markerFound: true,
        firstWrittenAt: prev.firstWrittenAt,
        writtenByBootId: prev.bootId,
        sameProcessAsWriter: prev.bootId === BOOT_ID,
        checkedAt: now,
      };
    }
    fs.writeFileSync(MARKER_FILE, JSON.stringify({ firstWrittenAt: now, bootId: BOOT_ID }));
    return { markerFound: false, markerWrittenNow: true, bootId: BOOT_ID, checkedAt: now };
  } catch (e) {
    return { markerFound: false, markerWrittenNow: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

const BOOT_ID = `${process.pid}-${Date.now().toString(36)}`;
const BOOTED_AT = Date.now();

function readFirstLine(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

@Injectable()
export class EnvProbeTools {
  @Tool({
    name: 'env_probe',
    description:
      'TEMPORARY deployment spike. Reports the hosting environment: node version, git availability, disk write and persistence, outbound HTTPS to GitHub, memory, port and transport. Optional shallow clone and hold timer test platform limits. Returns no secrets.',
    inputSchema: z.object({
      tryClone: z
        .boolean()
        .default(false)
        .describe('If true, shallow-clone a tiny public repo (octocat/Hello-World) into a temp dir and time it'),
      holdSeconds: z
        .number()
        .int()
        .min(0)
        .max(120)
        .default(0)
        .describe('Wait this many seconds before replying, to find the platform request timeout'),
    }),
    examples: {
      request: { tryClone: false, holdSeconds: 0 },
      response: {
        nodeVersion: 'v22.12.0',
        git: { available: true, version: 'git version 2.43.0' },
        cwd: '/app',
        disk: { cwd: { writable: true, readBackMatches: true } },
        network: [{ url: 'https://api.github.com/rate_limit', ok: true, status: 200 }],
        memory: { freeMb: 512, totalMb: 1024 },
        listening: { envPort: '3000', nodeEnv: 'production' },
      },
    },
  })
  async probe(input: { tryClone?: boolean; holdSeconds?: number }, ctx: ExecutionContext) {
    ctx.logger.info('env_probe called');
    const startedAt = Date.now();

    const git = await timed(async () => (await execFileAsync('git', ['--version'], { timeout: 5000 })).stdout.trim());

    const network = await Promise.all([
      probeHttps('https://api.github.com/rate_limit'),
      probeHttps('https://github.com'),
    ]);

    let clone: Record<string, unknown> | undefined;
    if (input.tryClone) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-clone-'));
      const r = await timed(async () => {
        await execFileAsync(
          'git',
          ['clone', '--depth', '50', '--filter=blob:none', '--single-branch', 'https://github.com/octocat/Hello-World.git', dir],
          { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        );
        const log = await execFileAsync('git', ['-C', dir, 'log', '--name-only', '--pretty=format:%h', '-n', '5'], {
          timeout: 10_000,
        });
        return log.stdout.split('\n').length;
      });
      fs.rmSync(dir, { recursive: true, force: true });
      clone = { ok: r.error === undefined, ms: r.ms, logLines: r.value, error: r.error };
    }

    const hold = Math.min(Math.max(input.holdSeconds ?? 0, 0), 120);
    if (hold > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, hold * 1000);
        ctx.abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    let diskFree: { freeMb: number; totalMb: number } | null = null;
    try {
      const s = fs.statfsSync(process.cwd());
      diskFree = {
        freeMb: Math.round((Number(s.bavail) * Number(s.bsize)) / 1048576),
        totalMb: Math.round((Number(s.blocks) * Number(s.bsize)) / 1048576),
      };
    } catch {
      diskFree = null;
    }

    const mem = process.memoryUsage();
    return {
      probe: 'env_probe v1 (temporary, Phase 1)',
      now: new Date().toISOString(),
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpus: os.cpus().length,
      cwd: process.cwd(),
      git: { available: git.error === undefined, version: git.value, error: git.error },
      disk: {
        cwd: probeDisk(process.cwd()),
        dataSnapshots: probeDisk(path.join(process.cwd(), 'data', 'snapshots')),
        tmp: probeDisk(os.tmpdir()),
        freeOnCwdVolume: diskFree,
        persistence: probePersistence(),
      },
      network,
      clone,
      memory: {
        freeMb: Math.round(os.freemem() / 1048576),
        totalMb: Math.round(os.totalmem() / 1048576),
        rssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
        cgroupLimit: readFirstLine('/sys/fs/cgroup/memory.max') ?? readFirstLine('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
      },
      listening: {
        envPort: process.env.PORT ?? null,
        envHost: process.env.HOST ?? null,
        nodeEnv: process.env.NODE_ENV ?? null,
        envMcpTransportType: process.env.MCP_TRANSPORT_TYPE ?? null,
        transportNote:
          'Per NitroStack docs, production (NODE_ENV=production) defaults to dual transport: Streamable HTTP at POST /mcp plus legacy SSE at /sse. This response itself arrived over HTTP if you called the live URL.',
      },
      secretsPresent: {
        GITHUB_TOKEN: Boolean(process.env.GITHUB_TOKEN),
        EXPORT_SECRET: Boolean(process.env.EXPORT_SECRET),
        RUNTIME_MODE: process.env.RUNTIME_MODE ?? null,
      },
      process: {
        uptimeSeconds: Math.round((Date.now() - BOOTED_AT) / 1000),
        bootId: BOOT_ID,
        pid: process.pid,
        uid: typeof process.getuid === 'function' ? process.getuid() : null,
      },
      probeMs: Date.now() - startedAt,
      heldSeconds: hold,
    };
  }
}
