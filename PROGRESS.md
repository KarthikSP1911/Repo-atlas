# RepoAtlas progress

**Current phase:** 0 (Setup), complete, waiting for `continue`
**Next:** Phase 1 (deployment spike: `env_probe` tool, deploy, pick RUNTIME_MODE)

## Done

### Phase 0: Setup
- Node v24.18.0, npm 11.16.0, git 2.55.0 verified (need Node >= 20.18, npm >= 9).
- `@nitrostack/cli` 1.1.1 installed; binary is `nitrostack-cli` (see D1).
- Scaffolded `typescript-starter`, moved to repo root, installed root and widget deps, calculator example removed.
- Modules generated: `graph`, `tour`, `contribute`, `actions` (see D5, D6).
- `CLAUDE.md`, `PROGRESS.md`, `docs/DECISIONS.md`, `.env.example`, `.gitignore` in place.
- Acceptance: `npm run build` and `npx tsc --noEmit` pass; server starts and `ping_repoatlas` answers over `POST /mcp` (initialize, tools/list, tools/call checked with curl).

## Open questions

- Does NitroCloud allow `git`, a writable disk, and outbound HTTPS? (Phase 1 spike decides RUNTIME_MODE.)
- Should the blueprint and guidebook stay git-ignored (D3)?

## Human steps still pending

- [H2] NitroStudio: install, sign in, connect the project, test `ping_repoatlas`.
- [H3] NitroCloud account created and login handy.
