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
