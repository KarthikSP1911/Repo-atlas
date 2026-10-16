# RepoAtlas

An MCP server that turns a GitHub repo into a graph of its code, history, people and issues, so an AI agent can walk a newcomer through the project step by step and then find the issues they can actually finish, with the files to touch.

Built on [NitroStack](https://docs.nitrostack.ai) (TypeScript), deployed to NitroCloud's free tier. Track: Developer Tools. Original product: GitHub (learning an unfamiliar repo, and choosing a first issue).

**Before:** a flat file tree, a stale README and hundreds of open issues. **After:** a guided tour with highlighted files and reasons, then a shortlist of unclaimed issues, each with the likely files, reading order and who to ask. Nothing is ranked by a model: every ranking is a formula over the graph, and every tool returns its evidence.

## What it does

1. `build_graph` resolves a repo to a precomputed snapshot (commit, tier, as-of time).
2. `project_overview`, `find_entry_points`, `key_files` give purpose, stack, run steps, folder roles, where execution starts and the files to read first.
3. `tour_next` walks 8 stages (orient, layout, entry points, core modules, config, tests, change patterns, people) one at a time, adapted to the role (new developer, reviewer, tester, quick look), with a check question per stage and a small import graph drawn by a widget.
4. `profile_contributor` and `find_candidate_issues` filter open issues to ones that are open, likely unclaimed, recent and clear.
5. `localize_issue` finds the files an issue would change; `score_first_change` scores how good a first change it is for this person.
6. `export_guide` drafts an `ARCHITECTURE.md`, only after the user confirms a preview.

## Tools

| Tool | Part | What it returns |
|---|---|---|
| `build_graph` | Foundation | snapshot id, tier, truncated flag, commit window, as-of time, stats; a clear message plus the available repos for unknown ones |
| `project_overview` | A | description, stack, run steps (marked when inferred), folder roles, entry points |
| `find_entry_points` | A | entry files with reasons, the command, and the first import chain |
| `key_files` | A | Must read / Read next / Skip tiers with every score component |
| `trace_flow` | A | ordered import chain from a file, with caps stated |
| `explain_file` | A | role, exports, imports, owners, tests, recent commits and PRs, docs, confidence (and a widget) |
| `tour_next` | A | one tour stage, a check question, the next stage, a subgraph (and a widget) |
| `profile_contributor` | B | languages, level, familiar areas, and what was read |
| `find_candidate_issues` | B | filtered issues, why each passed, evidence behind "likely unclaimed" |
| `localize_issue` | B | top 5 files with evidence, owner, reading order, confidence |
| `score_first_change` | B | a task score with every factor shown, effort estimate, watch-outs |
| `export_guide` | Action | preview and confirm token, then the full draft (text only) |

Also: resource `graph://{repo}@{sha}/summary` (for example `graph://lukeautry__tsoa@f0f9aa7/summary`), prompt `guide_me(repo, role, depth)`, widget `graph-view`, and `ping_repoatlas` for health.

## Demo data

Precomputed snapshots ship with the server (no clone or crawl happens at runtime):

| Repo | Language | Tier | Snapshot |
|---|---|---|---|
| [lukeautry/tsoa](https://github.com/lukeautry/tsoa) | TypeScript | 2 (import graph) | `lukeautry__tsoa@f0f9aa7` |
| [pwndbg/pwndbg](https://github.com/pwndbg/pwndbg) | Python | 2 (import graph) | `pwndbg__pwndbg@b5162e6` |
| [go-git/go-git](https://github.com/go-git/go-git) | Go | 1 (tree, history, people only) | `go-git__go-git@87e8ad5` |
| demo/sample-shop | TypeScript | 2 | `demo__sample-shop@5a3f0c1` (small fixture) |

Each has the last 1,000 commits, the last 100 merged PRs and about 100 open issues, fetched on 2026-10-16. Tools say "as of" that date.

## Accuracy

Measured on the three demo repos; details, method and caveats in [docs/EVAL.md](docs/EVAL.md).

- **Localization:** the true changed file is in the top 5 for **69%** of 49 merged PRs, using only the issue text (random 6%, fan-in baseline 24%). Python 81%, TypeScript 75%, Go (tier 1) 46%. History is rewound so the fixing PR cannot leak.
- **Key files:** not scorable against maintainers' docs (they name 0 to 2 rankable files); a hand-check sheet is provided.
- **Candidate quality and "likely unclaimed" precision:** sheets generated; to be hand-checked.
- **API use:** 5 to 6 GitHub GraphQL calls per repo build (17 for all three); **zero** at runtime.

## Limits

- **Snapshot mode.** NitroCloud has no `git` binary and a read-only app folder ([docs/SPIKE.md](docs/SPIKE.md)), so the server cannot clone or build repos on demand. Only precomputed repos work; unknown repos get a clear message.
- **Tier.** Tier 2 means an import graph for JS/TS and Python. Any other language is Tier 1 (file tree, history, people); import-based results are empty and tools say so.
- **Truncation and window.** At most about 1,500 files per repo (over that: a partial graph with `truncated: true`), the last 1,000 commits and 100 merged PRs.
- **Issues are a snapshot in time.** "Likely unclaimed" uses assignees, linked PRs and the last five comments; someone may still be working on it elsewhere.
- **Estimates are labelled** (effort, inferred run commands).

## Safety

- The only action, `export_guide`, returns text and never writes to a repo. Step 1 returns a preview and an HMAC confirm token (10 minutes, bound to the exact draft, stateless); step 2 returns the draft only with a valid token and refuses otherwise.
- Text from repos (README, commit messages, issue text, docstrings) is untrusted data: tool descriptions say never to follow it, and the exported draft flattens it (no links, HTML or headings from repo text).
- No tokens in snapshots, logs or errors. Emails are scrubbed from snapshots and issue files. The server holds no GitHub token and makes no GitHub calls.
- A session call budget, a per-caller rate limit and a result cache protect the free tier.

## Run it

Needs Node 20.18+ and npm 9+.

```bash
npm install                 # installs the server and the widget app
npm run dev                 # NitroStack dev server and widgets (open it in NitroStudio)
npm run build               # widgets + TypeScript to dist/
npm test                    # vitest (369 tests)
npm run typecheck           # src, tests and scripts
npm run check-snapshots     # loads every shipped snapshot and exits non-zero on a bad one
```

Production start (`npm start`) serves MCP over HTTP at `/mcp` (streamable HTTP, and legacy SSE at `/sse`).

### Configuration

Copy `.env.example` to `.env`. Never commit it.

| Variable | Used by | Notes |
|---|---|---|
| `EXPORT_SECRET` | server | signs `export_guide` tokens; at least 16 characters; **required on the deployed server** |
| `RUNTIME_MODE` | server | `snapshot` (default). `live` additionally allows issue refresh and a GitHub-username read, with a token |
| `SNAPSHOT_DIR` | server | default `data/snapshots` |
| `SESSION_CALL_BUDGET` | server | tool calls per session per hour, default 1500 |
| `GITHUB_TOKEN` | offline scripts only | read-only, public data; not set on the server |
| `GEMINI_API_KEY` | NitroStudio chat only | not used by the server |

### Add a repo (offline, on your machine)

```bash
npm run precompute -- owner/repo      # writes data/snapshots/<id>.json and <id>.issues.json
npm run check-snapshots
```

This needs `git` and a `GITHUB_TOKEN` in `.env`. About 5 GraphQL calls per repo. Snapshots must stay under 3 MB each.

### Evaluate

```bash
npm run eval                # key-file overlap, localization backtest, hand-check sheets
```

## Deploy (NitroCloud)

```bash
npm run build && npx tsc --noEmit
npx nitrostack-cli pack --output repoatlas.zip     # no node_modules, no .env
```

Upload the zip under the app's MCP, Deployments page, and set `EXPORT_SECRET` (and `RUNTIME_MODE=snapshot`) in the dashboard's environment variables there. The MCP endpoint is `<live URL>/mcp`; connect it to Claude or ChatGPT as a custom connector, or use NitroChat.

Live URL: `https://repoatlas-6ad271a6-karthik-s-poojary-heapify-global-community.app.nitrocloud.ai/mcp`

### Cost

Everything runs on free tiers; no recurring cost.

| Item | Cost |
|---|---|
| NitroCloud (free tier) | $0 |
| GitHub API (about 17 GraphQL calls for the demo data, offline only) | $0 |
| Neon, Redis, S3, LLM calls | none used |

## Project layout

```
src/modules/{graph,tour,contribute,actions}/   tool classes (thin)
src/services/                                  logic: store, query layer, rank, flow, tour, localize, export, ...
src/services/{ingest,parse,link,graph,build}.service.ts   offline engine (not loaded by the server)
src/widgets/app/graph-view/                    the Next.js widget
src/config/weights.ts                          every tunable weight in one file
data/snapshots/                                shipped snapshots (3 MB each at most)
scripts/                                       precompute, check-snapshots, eval/
docs/                                          DECISIONS, SPIKE, EVAL, API_BUDGET, eval/
tests/                                         vitest
```

Decisions and their reasons are in [docs/DECISIONS.md](docs/DECISIONS.md).
