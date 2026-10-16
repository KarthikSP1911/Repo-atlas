# RepoAtlas progress

**Current phase:** 1 (Deployment spike), in progress: waiting on [H5] (user deploys the zip and sends back the live URL and `env_probe` output)
**Next:** test the live `/mcp` endpoint, write `docs/SPIKE.md`, choose RUNTIME_MODE, then [H7] if needed

## Done

### Phase 0: Setup
- Node v24.18.0, npm 11.16.0, git 2.55.0 verified (need Node >= 20.18, npm >= 9).
- `@nitrostack/cli` 1.1.1 installed; binary is `nitrostack-cli` (see D1).
- Scaffolded `typescript-starter`, moved to repo root, installed root and widget deps, calculator example removed.
- Modules generated: `graph`, `tour`, `contribute`, `actions` (see D5, D6).
- `CLAUDE.md`, `PROGRESS.md`, `docs/DECISIONS.md`, `.env.example`, `.gitignore` in place.
- Acceptance: `npm run build` and `npx tsc --noEmit` pass; server starts and `ping_repoatlas` answers over `POST /mcp` (initialize, tools/list, tools/call checked with curl).

### Phase 1: Deployment spike (in progress)
- Added temporary `env_probe` tool (D10); build and `tsc --noEmit` pass; verified locally over `POST /mcp`.
- Built `repoatlas-spike.zip` (171.6 KB, git-ignored) with `nitrostack-cli pack`.
- H2 and H3 confirmed by the user: NitroCloud app `repoatlas` exists, dashboard offers zip upload and GitHub connect.
- Remaining: user deploys (H5), I test the live endpoint, write `docs/SPIKE.md`, pick RUNTIME_MODE.

## Open questions

- Does NitroCloud allow `git`, a writable disk, and outbound HTTPS? (Phase 1 spike decides RUNTIME_MODE.)
- Should the blueprint and guidebook stay git-ignored (D3)?

## Human steps still pending

- [H5] Test `env_probe` in NitroStudio, deploy the zip, send back the live URL and the probe output.
