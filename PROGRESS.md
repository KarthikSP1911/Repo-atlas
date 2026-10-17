# RepoAtlas progress

**Current phase:** 7 (Evaluation and docs) complete. Phases 0 to 7 are done; the user asked for them to run without stopping. Waiting on the human steps below before Phases 8 and 9.
**Decision:** precomputed snapshots plus on-demand builds of any public GitHub repo (D18, which lifts the snapshot-only rule of D11 for `build_graph`)
**Next:** Phase 8 (production deploy and verification): redeploy the zip, set env vars, run the live smoke test, cross-network and connector tests. Then Phase 9 (submission pack).

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

### Phase 3: Graph engine (done)
- Engine services, `npm run precompute`, three demo snapshots (tsoa, pwndbg, go-git; 17 GraphQL calls), `docs/API_BUDGET.md`. Email scrubbing, language and example-entry fixes came from the first real runs (D15).

### Phase 4: Part A tools (done)
- build_graph, project_overview, find_entry_points, key_files, trace_flow, explain_file, tour_next, guide_me prompt, resource. `GraphIndex` and shared helpers. Tested per tool, then over a live `/mcp` server (D16).

### Phase 5: Part B tools (done)
- profile_contributor, find_candidate_issues, localize_issue (MiniSearch BM25 + history + graph + recency), score_first_change. Weights in `src/config/weights.ts`.

### Phase 6: Action, widget, policies (done, widget not yet seen in Studio)
- export_guide (preview + HMAC token; refusal tested), graph-view widget on tour_next and explain_file, @Policies (cache, rate limit, budget), SnapshotsHealthCheck. `tests/schema-compat.test.ts` gates a framework failure mode (D16).

### Phase 7: Evaluation and docs (done)
- `npm run eval`: backtest hit@5 69% on 49 PRs, key-file overlap not scorable, hand-check sheets in `docs/eval/`. `docs/EVAL.md`, `README.md`, D17. Weights not changed (tuning did not generalize).
- 369 tests pass; `npm run typecheck` and `npm run build` pass.

### After Phase 7: website, live demo, tool explorer and any-repo `build_graph` (done, not yet deployed)
- `web/` is a static Next.js site (Next.js-inspired theme, Geist fonts): landing page, live demo (`/demo/`), tool explorer (`/tools/`, all 12 tools with the graph widget) and a repo box that takes any GitHub URL.
- `build_graph` now builds any public GitHub repo on demand from GitHub's tarball, with no git binary (D18; `src/services/live/`). Precomputed repos are still served first. Verified over a real `/mcp` server on pallets/click (all 12 tools), and against React and Next.js for limits.
- 535+ tests pass; `tests/server-imports.test.ts` guards the deployed server's imports.
- New optional server settings: `GITHUB_TOKEN` (richer data, no download rate limit), `LIVE_BUILDS`, `LIVE_BUILDS_PER_HOUR`, `LIVE_BUILD_TIMEOUT_MS`, `LIVE_SNAPSHOT_TTL_MIN`.
- NitroCloud still runs the old spike build until `npm run deploy:pack` and an upload.

## Open questions

- Where does the NitroCloud dashboard set environment variables? (needed for `EXPORT_SECRET`; [H7])
- Is a shipped file under `/app/data/snapshots` readable at runtime? Confirm on the first redeploy (a redeploy is also what removes the live `env_probe` and shows whether the dashboard env vars apply, via `ping_repoatlas.exportSecretConfigured`). Suggest redeploying after Phase 4.
- A GitHub token was pasted into `.env.example` (D12). Move it to `.env`; consider rotating it.
- Should the blueprint and guidebook stay git-ignored (D3)?

## Human steps still pending (collected at the end of Phase 7)

- Redeploy the zip to NitroCloud (the live server still runs the Phase 1 spike zip) and confirm env vars apply (`ping_repoatlas`: `exportSecretConfigured`, `liveBuilds`, `githubTokenConfigured`).
- Optional: add `GITHUB_TOKEN` (read-only, no scopes) in the NitroCloud dashboard's environment variables so on-demand builds get PRs, issue comments and per-commit history. Without it, builds still work with fewer signals.
- Test the 12 tools and the `graph-view` widget in NitroStudio.
- Fill in the three hand-check sheets in `docs/eval/`.
- Phase 8 and 9 items (cross-network test, Claude or ChatGPT connector, demo video, LinkedIn post, portal).
