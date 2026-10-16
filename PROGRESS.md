# RepoAtlas progress

**Current phase:** 1 (Deployment spike), complete, waiting for `continue`
**Decision:** RUNTIME_MODE=snapshot (D11, `docs/SPIKE.md`)
**Next:** Phase 2 (snapshot schema, store service, sample data, resource); remove `env_probe` from code

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

## Open questions

- Where does the NitroCloud dashboard set environment variables? (needed for `EXPORT_SECRET`; [H7])
- Is a shipped file under `/app/data/snapshots` readable at runtime? Confirm on the first redeploy after Phase 2.
- A GitHub token was pasted into `.env.example` (D12). Move it to `.env`; consider rotating it.
- Should the blueprint and guidebook stay git-ignored (D3)?

## Human steps still pending

- [H7] done (user-confirmed): `EXPORT_SECRET` and `RUNTIME_MODE=snapshot` set in the NitroCloud dashboard under MCP > Deployments. Not yet verified on the live server: whether they apply without a redeploy, and whether they persist across deployments. Verify on the first redeploy (Phase 2 adds `exportSecretConfigured` and `runtimeMode` to `ping_repoatlas`, booleans only).
- [H4] `GITHUB_TOKEN` must live in `.env`, not `.env.example` (see D12).
