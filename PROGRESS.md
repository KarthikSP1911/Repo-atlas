# RepoAtlas progress

**Current phase:** 3 (Graph engine), in progress: engine and script done and tested; blocked on [H6] (approve demo repos) to run the real precompute
**Decision:** RUNTIME_MODE=snapshot (D11, `docs/SPIKE.md`)
**Next:** after H4 and H6: run `npm run precompute -- <3 repos>`, commit the snapshots, write `docs/API_BUDGET.md`, finish Phase 3 (acceptance: each snapshot loads via StoreService, counts sane, call counts logged).

## Done

### Phase 0: Setup
- Node v24.18.0, npm 11.16.0, git 2.55.0 verified (need Node >= 20.18, npm >= 9).
- `@nitrostack/cli` 1.1.1 installed; binary is `nitrostack-cli` (see D1).
- Scaffolded `typescript-starter`, moved to repo root, installed root and widget deps, calculator example removed.
- Modules generated: `graph`, `tour`, `contribute`, `actions` (see D5, D6).
- `CLAUDE.md`, `PROGRESS.md`, `docs/DECISIONS.md`, `.env.example`, `.gitignore` in place.
- Acceptance: `npm run build` and `npx tsc --noEmit` pass; server starts and `ping_repoatlas` answers over `POST /mcp` (initialize, tools/list, tools/call checked with curl).

### Phase 1: Deployment spike
- Temporary `env_probe` tool deployed via `nitrostack-cli pack` zip (D10). Live URL: `https://repoatlas-6ad271a6-karthik-s-poojary-heapify-global-community.app.nitrocloud.ai` (`/mcp`, no auth).
- Live results: no git, `/app` read-only, `/tmp` writable, GitHub HTTPS reachable, 500 MB memory, Node 20.20.2 arm64, requests of 100 s OK.
- Decision: `RUNTIME_MODE=snapshot` (D11). Written up in `docs/SPIKE.md`; platform facts added to `CLAUDE.md`.
- Live `env_probe` still deployed until the next redeploy (public, harmless; removed from code in Phase 2).

### Phase 2: Snapshot schema and sample data
- `src/services/snapshot.schema.ts` (types, Zod schemas, integrity rules, id helpers) and `src/services/store.service.ts` (lazy load, validation, LRU of 3, ref resolution, `summarize`). See D14.
- `data/snapshots/sample.json`: 40 nodes, 80 edges, 21 KB.
- Resource `graph://{repo}@{sha}/summary` in the graph module (`graph.resources.ts`).
- `env_probe` removed from code; `ping_repoatlas` reports `exportSecretConfigured`.
- vitest added. 43 unit tests pass (load, validate, summary, LRU, refs, ids, resource). `npm run typecheck` and `npm run build` pass. Checked on the real server over `/mcp`: DI, template read, helpful error.
- Not redeployed yet: the live server still runs the Phase 1 zip (with `env_probe`).

### Phase 3: Graph engine (in progress)
- Services `ingest`, `parse`, `link`, `graph`, `build` and `issues.schema` in `src/services/` (D15); `npm run precompute -- owner/repo ...` in `scripts/precompute-snapshots.ts`.
- 133 vitest tests pass, including an end-to-end build of a real local git repo cloned by `file://`. `npm run typecheck` and `npm run build` pass; the server's import graph does not reach the offline engine.
- Dogfooded without GitHub data on pallets/click (280 KB) and sindresorhus/ky (274 KB). Fixed six quality problems that run exposed (exports field, devDependency stack, test-file centrality, example entry points, PageRank sink bias, config stems).
- Real GraphQL smoke test on pallets/click (scratchpad output, not committed): 5 calls, cost 9 points, 4,991 remaining; snapshot and issues file pass their schemas; token absent from outputs. It exposed fuzzy label search (fixed). [H4] confirmed done.
- Research agent's demo-repo shortlist is in chat awaiting [H6]: tsoa (TS), pwndbg (Python), go-git (Go, tier 1).

## Open questions

- Where does the NitroCloud dashboard set environment variables? (needed for `EXPORT_SECRET`; [H7])
- Is a shipped file under `/app/data/snapshots` readable at runtime? Confirm on the first redeploy (a redeploy is also what removes the live `env_probe` and shows whether the dashboard env vars apply, via `ping_repoatlas.exportSecretConfigured`). Suggest redeploying after Phase 4.
- A GitHub token was pasted into `.env.example` (D12). Move it to `.env`; consider rotating it.
- Should the blueprint and guidebook stay git-ignored (D3)?

## Human steps still pending

- [H7] done (user-confirmed): `EXPORT_SECRET` and `RUNTIME_MODE=snapshot` set in the NitroCloud dashboard under MCP > Deployments. Not yet verified on the live server: whether they apply without a redeploy, and whether they persist across deployments. Verify on the first redeploy (Phase 2 adds `exportSecretConfigured` and `runtimeMode` to `ping_repoatlas`, booleans only).
- [H6] Approve the 3 demo repos (proposed: lukeautry/tsoa, pwndbg/pwndbg, go-git/go-git).
