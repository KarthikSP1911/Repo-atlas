# Decisions

Newest at the bottom. Format: what was decided, why, and what it replaces (docs vs blueprint conflicts are marked **[docs > blueprint]**).

## D1. CLI binary and package (Phase 0)

- Package `@nitrostack/cli` (v1.1.1), installed globally with `npm i -g @nitrostack/cli`.
- Real binary: `nitrostack-cli` (its `--help` prints the usage name `nitrostack`). There is no `nitrostack` binary on PATH.
- Commands: `init, dev, build, start, generate|g, upgrade, install|i, cursor|c, pack`.
- **There is no `login` or `deploy` command.** Deploy is via NitroStudio's deploy button or the NitroCloud dashboard (zip upload or GitHub). `nitrostack-cli pack` exists: it writes a zip that excludes `node_modules`, `.git`, `.next`, `dist` and `.env*`. Phase 1 and 8 use `pack` for the zip route. **[docs > prompt]**

## D2. Source documents have different filenames (Phase 0)

The prompt names `docs/BLUEPRINT.md` and `docs/GUIDEBOOK.pdf`. The files on disk are `docs/RepoAtlas Project Blueprint.md` and `docs/Buildathon Guidebook (1).pdf`. Left as-is; `CLAUDE.md` uses the real names.

## D3. `.gitignore`: narrowed `/docs` (Phase 0)

The pre-existing untracked `.gitignore` contained `/docs`, which would have hidden `DECISIONS.md`, `SPIKE.md`, `EVAL.md` and the other docs this project must commit. It now ignores only the two event source files (the blueprint and the guidebook), assuming they were meant to stay private. If they should be public, delete those two lines. The template's ignore rules (`node_modules`, `dist`, `.env`, widget `.next` and `out`) are merged in, plus `*.zip` for `pack` output.

## D4. Scaffold layout (Phase 0)

Scaffolded with `nitrostack-cli init repoatlas-app --template typescript-starter --skip-install`, moved to the repo root, then `nitrostack-cli install` (root and `src/widgets`). Package names are `repoatlas` and `repoatlas-widgets`. The template's generic README was dropped (the repo keeps its own README, rewritten in Phase 7). The template installs agent skill folders (`.claude/skills`, `.cursor`, `.codex`, `.gemini`, `.agents`, `.antigravity`, `.copilot`, `.opencode`); kept as generated.

## D5. No `@Controller` prefixes (Phase 0)

The SDK reference says `@Controller(prefix)` renames tools to `${prefix}_name`. Tool names must be exactly the 12 in blueprint section 8, so modules list plain `@Injectable` tool classes in `controllers: [...]`, as the starter template does. The blueprint's "shared prefixes" idea is dropped. **[docs > blueprint]**

## D6. Generated module cleanup (Phase 0)

`nitrostack-cli generate module <name>` emits lowercase class names (`graphTools`) and a TODO example tool plus resource and prompt stubs. Replaced with PascalCase classes. `tour`, `contribute` and `actions` are empty modules for now; `graph` holds the temporary `ping_repoatlas` tool. Resource `graph://{repo}@{sha}/summary` goes in the `graph` module and prompt `guide_me` in the `tour` module (Phases 2 and 4).

## D7. Layout follows NitroStack, not the blueprint tree (Phase 0)

Blueprint section 11 shows `src/modules/*/*.controller.ts` and `src/resources`, `src/prompts`. NitroStack's convention (and the prompt) is `*.tools.ts` per module, shared logic in `src/services/`, widgets in `src/widgets/app/<name>/page.tsx`. Following NitroStack. **[docs > blueprint]**

## D8. Transport and port (Phase 0)

Production start (`nitrostack-cli start`, `NODE_ENV=production`) runs dual transport: Streamable HTTP at `POST /mcp` (modern 2026-07-28 stateless, legacy fallback) plus legacy SSE at `/sse`. Verified locally with `curl` (initialize, tools/list, tools/call). The dual-transport guide still mentions `/mcp/sse` and `/mcp/message`; the streamable-HTTP guide says those aliases were removed. The server behaves as the streamable-HTTP guide says. Port comes from `PORT`; `nitrostack-cli start --port` also works.

## D9. Widgets bundle with zero widgets (Phase 0)

After removing the calculator widget, `nitrostack-cli build` still succeeds ("0 widgets"). `src/widgets/widget-manifest.json` has an empty `widgets` array until Phase 6 adds `graph-view`.

## D10. Phase 1 spike tool and deploy route (Phase 1)

- Temporary tool `env_probe` in `src/modules/graph/env-probe.tools.ts` (registered in `GraphModule`). It reports node version, `git --version`, write/read-back on cwd, `data/snapshots` and tmp, a persistence marker in `.probe/` (the second call after a restart or redeploy shows whether it survived), outbound HTTPS to `api.github.com/rate_limit` and `github.com`, memory and cgroup limit, `PORT`/`NODE_ENV`/transport env, and whether `GITHUB_TOKEN`/`EXPORT_SECRET` are set (booleans only). Optional `tryClone` times a shallow blobless clone of `octocat/Hello-World`; optional `holdSeconds` (max 120) finds the request timeout. Deleted in Phase 2 once `docs/SPIKE.md` is written.
- Local result (Windows, Node 24): git present, GitHub reachable, clone of a tiny repo 3.0s, persistence marker survives within a process.
- Deploy route: zip via `nitrostack-cli pack --output repoatlas-spike.zip` (171.6 KB, 65 entries, respects `.gitignore`, excludes `node_modules`, `dist`, `out`, `.env*`, `.git`; the blueprint and guidebook are not in it). The dashboard shows both zip upload and GitHub connect (user-confirmed). Zip is primary; GitHub auto-deploy would need a public remote and is left as a Phase 8 option. `pack` does not edit `.gitignore` here.
- `.probe/` added to `.gitignore`.

## D11. RUNTIME_MODE = snapshot (Phase 1)

Chosen from the live spike (`docs/SPIKE.md`): NitroCloud has no `git` binary, `/app` is read-only (only `/tmp` is writable, ephemeral), memory is capped at 500 MB, and the host is Node 20.20.2 on linux/arm64. Network to GitHub works and requests can run 100 s or more, but without git a live clone is not possible.

Consequences:
- `build_graph` serves shipped snapshots only; unknown repos get a clear message listing what is available.
- `ts-morph`, `simple-git`, Octokit and `tsx` are devDependencies; `scripts/` lives outside `src/`.
- No runtime GitHub calls, so `GITHUB_TOKEN` is not set on NitroCloud. Phase 5's live issue refresh stays behind `RUNTIME_MODE=live` and is not used in production.
- `EXPORT_SECRET` must be set on NitroCloud before Phase 6 is deployed.
- Runtime dependencies must be pure JS (arm64, no native modules).
- `env_probe` is removed from code in Phase 2; the live copy goes away on the next redeploy.

## D12. Secrets belong in `.env`, never `.env.example` (Phase 1)

A real GitHub token was found pasted into the tracked `.env.example` (working tree only, never staged or committed; checked with `git log -S`). Do not stage `.env.example` while it holds a value. The token should move to `.env` (git-ignored) and `.env.example` go back to blank values. Commits since then stage files by path.

## D13. NitroCloud env vars live under MCP > Deployments (Phase 1)

Found by the user: the dashboard sets environment variables under **MCP > Deployments** (the MCP Settings page has only Name, Slug and Delete; Delete's help text confirms variables are tied to the MCP). `EXPORT_SECRET` and `RUNTIME_MODE=snapshot` were set there. The `pack --include-env` fallback is no longer needed. Open: whether a change applies without a redeploy and whether values carry over to later deployments; check by calling `ping_repoatlas` after the next deploy (it reports `exportSecretConfigured` and `runtimeMode`, never the secret).

## D14. Snapshot schema and store (Phase 2)

Types are the blueprint section 5 types, defined once as Zod schemas in `src/services/snapshot.schema.ts` (re-exported from `store.service.ts`). Additions and choices:
- **`schemaVersion: 1`** is required on every snapshot so the format can change later without guessing.
- **Integrity rules** run on load (a failing file is skipped and reported by `StoreService.problems()`, never served): unique node ids; node id must start with `<kind>:`; every edge endpoint must exist; edge endpoint kinds must fit the edge kind (for example `imports` is file to file); `fixes` and `describes` edges must carry a `confidence`; `file` and `dir` nodes need `meta.path`.
- **File `meta` conventions** (all optional, extra keys allowed): `path, lang, loc, fanIn, fanOut, centrality (0..1), churn, isEntry, isConfig, isTest, testFor, docsMentions, lastChangedAt, owners`. Phase 3 writes them, Phase 4 reads them with `getFileMeta`. They carry the inputs of the `key_files` formula.
- **No emails or tokens in snapshots.** People are `person:<login>` nodes.
- **Size caps:** 3 MB per file (rejected above it), 25,000 nodes, 100,000 edges.
- **Ids:** `owner__repo@sha7`. GitHub owners cannot contain `_`, so the first `__` is the separator.
- **Refs:** tools accept an id, the file name alias (`sample`), `owner/repo`, `owner__repo`, or a GitHub URL. A bare repo resolves to its newest snapshot. Wrong or unknown refs get an error that lists the available snapshots and says the server is in snapshot mode.
- **Index and cache:** the directory is scanned once and every file validated into a small index (id, repo, sha, builtAt, tier, truncated). Full snapshots load lazily into an LRU of 3.
- **`StoreService` has no constructor parameters** (NitroStack DI would try to inject them). `dir` defaults to `SNAPSHOT_DIR` and is overridable in tests. It is provided and exported by `GraphModule`; other modules import `GraphModule` to inject it.
- **Resource URI:** `graph://{repo}@{sha}/summary` with `{repo}` = `owner__repo` and `{sha}` = 7-char prefix, because NitroStack matches each `{var}` as `[^/]+` (verified in `core/server.js`), so `owner/repo` cannot fit in one variable. Example: `graph://demo__sample-shop@5a3f0c1/summary`. Resource handlers may return a plain object; the framework wraps it as JSON (the template's `{contents: [...]}` shape would be double-wrapped). **[docs > blueprint]**
- **Sample data:** `data/snapshots/sample.json` is a made-up `demo/sample-shop` repo (40 nodes, 80 edges, tier 2) generated once by a throwaway script so edges and metrics agree; only the JSON is committed. It is the fixture for Phase 4 and 5 tests and ships in the deploy zip.
- **Tests** live in `tests/` (outside `src/` so the deploy build never compiles them). `npm test` runs vitest; `npm run typecheck` checks `src` and `tests`.
- `env_probe` removed from code. `ping_repoatlas` now also reports `exportSecretConfigured` (boolean) to verify the NitroCloud env var after the next deploy (D13).
