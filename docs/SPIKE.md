# Phase 1 spike: what NitroCloud allows

Run on 2026-10-17 against the live deployment of `repoatlas-spike.zip` (commit `c24a1f5`, tool `env_probe`). Live URL: `https://repoatlas-6ad271a6-karthik-s-poojary-heapify-global-community.app.nitrocloud.ai` (MCP endpoint `/mcp`).

**Decision: `RUNTIME_MODE=snapshot`.** The live host has no `git` binary and a read-only app directory, so `build_graph` cannot clone and build on demand. It serves snapshots shipped inside the deploy zip.

## Results

| Question | Result | Evidence |
|---|---|---|
| Is `git` available? | **No** | `spawn git ENOENT`; the `tryClone` test failed in 3 ms |
| Is the app disk writable? | **No** for `/app` (cwd, `data/snapshots`, `.probe`); **yes** for `/tmp` | `EACCES: permission denied, mkdir '/app/data/snapshots'`; `/tmp` write and read-back OK |
| Does a written file survive a restart? | Not testable for `/app` (read-only). `/tmp` is scratch only and must not be relied on | marker write to `/app/.probe` was refused |
| Outbound HTTPS to GitHub? | **Yes** | `api.github.com/rate_limit` 200 in 281 ms (unauthenticated limit 60, remaining 60); `github.com` 200 in 182 ms |
| How long can a request run? | At least **100 s** (SSE `: keepalive` frames keep the stream open) | `holdSeconds` 60 and 100 both returned HTTP 200 after 61 s and 101 s |
| Memory | cgroup limit **500 MB** (`524288000`); about 99 MB RSS idle | `memory.cgroupLimit`, `rssMb` |
| Runtime | Node **v20.20.2**, **linux/arm64**, 16 CPUs visible, uid 1000 | `nodeVersion`, `platform`, `process.uid` |
| Port and transport in production | `PORT=3000`, `HOST=0.0.0.0`, `NODE_ENV=production`; `/mcp` is Streamable HTTP (this probe arrived over it); no auth required; CORS open | `listening`, `/mcp/health` 200, `initialize` and `tools/list` over HTTP |
| Env vars set on the host | `GITHUB_TOKEN`, `EXPORT_SECRET`, `RUNTIME_MODE` all unset (as expected) | `secretsPresent` |
| Disk free | about 14 GB free of 51 GB on the app volume (irrelevant while it is read-only) | `freeOnCwdVolume` |
| Chromium or Playwright? | Not tested; ruled out by the constraints (no headless browser) | n/a |

Local check for comparison (Windows, Node 24): git present, shallow blobless clone of `octocat/Hello-World` took 3.0 s, so the slow part of a live mode would have been the host, not the code.

## What this means for the build

1. **Snapshots ship in the zip** under `data/snapshots/` and are read-only at runtime. Resolve the directory against `process.cwd()` (`/app` on the host) and confirm with a redeploy in Phase 2 that a shipped file is readable.
2. **No clone, no `git log`, no `simple-git` on the server.** `build_graph` returns the shipped snapshot for known repos and a clear message (with the list of available snapshots) for unknown ones. Precompute runs on a developer machine only (`npm run precompute`, Phase 3).
3. **Heavy dependencies are devDependencies:** `ts-morph`, `simple-git`, `@octokit/*` (and `tsx` for scripts). Keep `scripts/` outside `src/` so `tsc` and the deploy build never compile or import them. Whether NitroCloud prunes devDependencies after its build is not known; the zip stays small either way.
4. **Runtime needs only pure JS:** `graphology`, `minisearch`, `zod`. The host is arm64 Linux, so avoid native modules (no tree-sitter; Python uses regex hints as planned).
5. **Memory:** an LRU of 3 snapshots at under 3 MB each fits easily in 500 MB.
6. **GitHub at runtime:** reachable, but the unauthenticated limit is 60 per hour per egress IP, which a shared host could exhaust. In snapshot mode there are **no runtime GitHub calls**, so `GITHUB_TOKEN` is **not** set on NitroCloud. `find_candidate_issues` reads `<id>.issues.json` (with its `fetchedAt`) and says "as of <time>". The Phase 5 "refresh in live mode" path stays behind `RUNTIME_MODE=live` and is not used on the deployed server.
7. **`EXPORT_SECRET` is still needed on NitroCloud** (Phase 6, HMAC confirm token). How the dashboard sets env vars is not documented in the NitroStack docs; [H7] asks the user to find it.
8. **Dev and prod differ:** local Node 24 on Windows, host Node 20.20.2 on arm64 Linux. Use only Node 20-compatible APIs and normalise paths with `node:path`.

## Cleanup

`env_probe` is still deployed. It is harmless but public (its `holdSeconds` input can tie up a request for up to 120 s), so it is removed from the code in Phase 2 and disappears from the live server at the next redeploy. The code stays in git history at `c24a1f5`.

## Raw probe output (live, trimmed)

```json
{
  "nodeVersion": "v20.20.2",
  "platform": "linux/arm64",
  "cwd": "/app",
  "git": { "available": false, "error": "spawn git ENOENT" },
  "disk": {
    "cwd": { "writable": false, "error": "EACCES: permission denied, open '/app/.probe-write-18.txt'" },
    "dataSnapshots": { "writable": false, "error": "EACCES: permission denied, mkdir '/app/data/snapshots'" },
    "tmp": { "writable": true, "readBackMatches": true }
  },
  "network": [
    { "url": "https://api.github.com/rate_limit", "ok": true, "ms": 281, "status": 200, "rateLimitRemaining": "60" },
    { "url": "https://github.com", "ok": true, "ms": 182, "status": 200 }
  ],
  "memory": { "freeMb": 54700, "totalMb": 63134, "rssMb": 99, "cgroupLimit": "524288000" },
  "listening": { "envPort": "3000", "envHost": "0.0.0.0", "nodeEnv": "production" },
  "secretsPresent": { "GITHUB_TOKEN": false, "EXPORT_SECRET": false, "RUNTIME_MODE": null }
}
```
