# Verification report: RepoAtlas against the Buildathon Guidebook and the Blueprint

Checked on 2026-10-17 at commit `391d46e` plus the navbar and font change. Method: read the guidebook PDF (17 pages) and the blueprint in full, then checked each requirement with a command, a test or a live call. Status key: PASS = verified here; PARTIAL = works but something is missing; OPEN = not done, needs the owner; DEVIATION = intentional, recorded.

## Verdict

**The product and the code meet the requirements. The submission does not yet**, because deployment and hand-in steps are still open. Nothing found is a design problem; every open item is an action.

| Area | Result |
|---|---|
| Build rules (guidebook 4, 6) | PASS |
| MCP centrality, clarity, execution (guidebook 7) | PASS (demo video still to record) |
| Blueprint product behaviour (tools, ranking, safety) | PASS, 48 of 48 live checks |
| Blueprint validation numbers (section 13) | PARTIAL: localization measured, three hand-checks not done |
| Deployment (guidebook 6) | PARTIAL: live, but behind and `export_guide` fails live |
| Submission package (guidebook 8) | OPEN: 5 of 7 items |

## Evidence collected

- **525 unit tests pass**; `npm run typecheck` (source, tests, scripts) and `tsc` exit 0; `npm run build` and `npm run deploy:pack` succeed; the static site builds.
- **48 of 48 live checks** (`npm run verify:server`, run against a freshly started local server over `/mcp`, no GitHub token): registration, schemas, evidence and limits on each tool, ranking formulas, the tour for all four roles, safety, rate limiting. The same script run against the **live NitroCloud server** passed 45 of 47; the two failures are the export steps (see Deployment). Re-run it after every redeploy.
- **Live NitroCloud server probed** (read-only calls): see "Deployment".
- **Secret scan of every commit**: no real token. The only match is a fake string in a sanitiser test.
- **Real repos**: precomputed tsoa, pwndbg, go-git; built on demand: flask, express, click, cobra, React, Next.js.

## Guidebook requirements

| Requirement | Status | Evidence |
|---|---|---|
| Delivered as an MCP server on NitroStack (TypeScript) | PASS | `@nitrostack/core` 1.1.1, `@nitrostack/cli` 1.1.1, `@nitrostack/widgets` in `src/widgets`; 13 `@Tool`, 1 `@Resource`, 1 `@Prompt`, 2 `@Widget` |
| One product, one workflow, one track | PASS | GitHub: learning an unfamiliar repo and choosing a first issue; Developer Tools |
| Tools, a resource and a prompt exposed and discoverable | PASS | `tools/list` returns the 12 names plus `ping_repoatlas`; template `graph://{repo}@{sha}/summary` reads; prompt `guide_me(repo, role, depth)` renders |
| Scaffold with the CLI; explore the template | PASS | Phase 0 in `PROGRESS.md`; template example removed, no leftovers |
| One focused job per tool, specific names and descriptions | PASS | all 12 descriptions are 150+ characters |
| Do not hand-write JSON schemas | PASS | all input schemas are Zod; generated schemas present on every tool |
| Do not hardcode values that should be parameters | PASS | all weights in `src/config/weights.ts`; repo, role, stage, snapshot are inputs |
| Policies: `@Cache`, `@RateLimit`, `@UseGuards` | PASS | one `@Policies()` on 12 tools; rate limit tripped live (20 a minute on `export_guide`); call budget refused at call 5 of 4; cache active |
| Add policies only after the core works | PASS | Phase 6 after Phases 4 and 5 |
| Widgets | PASS | `graph-view` on `tour_next` and `explain_file`; route returns HTTP 200; rendered in NitroStudio earlier; not re-screenshotted after the last declutter |
| Test each tool alone in NitroStudio | PARTIAL | every tool tested alone by unit test and live call; in Studio you ran `build_graph` and `tour_next`; `key_files`, `explain_file` and the rest not reported back |
| `npm run build` and `tsc` clean before deploy | PASS | both succeed |
| Zip under 100 MB, no `node_modules` | PASS | `repoatlas.zip` is 968 KB; the pack script checks contents |
| Deploy early; test live from another network | PARTIAL | deployed and answering; tested from this machine only |
| Live server matches the code | OPEN | see "Deployment" |
| NitroChat check; connect to Claude or ChatGPT | OPEN | not done |
| Template is not the submission | PASS | original workflow |

## Judging criteria (guidebook 7)

| Criterion | Assessment |
|---|---|
| MCP centrality (biggest factor) | Strong. One conversation chains tools over parsed code, git history, merged PRs, issues and docs, and ends in a confirmed action (`export_guide`, preview then token). A single API call cannot do that. Caveat: the action is broken on the live server until `EXPORT_SECRET` is set. |
| Clarity of improvement | Strong. Landing page shows before (N open issues, flat tree) against after (shortlist with files and fit scores) with real numbers. The demo video should show the same side by side. |
| Demo quality | Live demo page and tool explorer run the real workflow in a browser. The recorded video does not exist yet. |
| Execution given the time | Strong. All 12 tools work and are tested. Stretch items were cut in the blueprint's own order. |

## Blueprint requirements

| Requirement | Status | Evidence |
|---|---|---|
| 12 tools with the exact names, plus resource, prompt, widget | PASS | live check A |
| Every tool returns evidence and limits (tier, as-of, truncated, commit window, notes) | PASS for 10; the other two state their own | `project_overview`, `find_entry_points`, `key_files`, `trace_flow`, `explain_file`, `tour_next`, `find_candidate_issues`, `localize_issue`, `score_first_change`, `build_graph` carry `limits`. `profile_contributor` states what it read; `export_guide` states `willWrite: false` and expiry |
| Graph model: 8 node kinds, 8 edge kinds, snapshot with tier, truncated, commit window, built-at | PASS | `snapshot.schema.ts` and its tests |
| Size caps: about 1,500 files, skip vendored and generated, partial graph with a message | PASS | React kept 1,500 of 7,260 and said so; Next.js likewise |
| Metrics: fan-in, fan-out, centrality, churn, tests | PASS | in every file node |
| `key_files` formula and 10% / 25% tiers | PASS | weights 3, 2, 1.5, 1, 1, 0.5 returned; tier sizes within 3 points of 10 / 25 / 65 |
| `localize_issue`: top 5, evidence, owner, reading order, confidence; four components | PASS | text match, history similarity, graph proximity, recency all returned |
| `score_first_change`: six factors each floored at 0.1, shown; effort labelled estimate | PASS | |
| Issue filters (open, not a PR, unclaimed with evidence, not stale, not blocked, clear) | PASS | candidate tests; each result lists why it passed and the filter counts |
| Tour: 8 stages, role matrix, check question with answer, bridge to Part B | PASS | new developer 1 to 8, reviewer 1,3,4,7,8, tester 1,3,6, quick look 1,2,3 |
| Widget draws at most 25 nodes and does no ranking | PASS | |
| Two-step export, nothing written to a repo | PASS | preview; wrong token refused; token for another snapshot refused; draft is text only |
| Repo, issue and README text is untrusted data | PASS | stated in 11 of 12 descriptions (not needed in `profile_contributor`); exported draft flattens repo text; injected README text stays quoted data in tests |
| Never log or return tokens | PASS | 0 token-like strings in server logs or outputs; tests search every output for the token |
| Evidence, confidence and limits stated | PASS | |

## Blueprint section 13: validation numbers

| Check | Status | Result |
|---|---|---|
| Localization accuracy (hit@5) | PASS | **69% on 49 merged PRs** (random 6%, fan-in baseline 24%); needed 15 to 20 PRs. History is rewound so the fix cannot leak. Details in `docs/EVAL.md` |
| API usage per build | PASS | 5 to 6 GraphQL calls per precomputed repo, 17 for three; `docs/API_BUDGET.md` |
| Key-file overlap | PARTIAL | reported as "not scorable" (maintainers' docs name 0 to 2 rankable files); the human sheet is empty |
| Candidate quality (top 10) | OPEN | `handcheck-candidates.csv`: 0 of 40 human cells filled |
| Claim detection (20 issues) | OPEN | `handcheck-claims.csv`: 0 of 40 filled |
| Docs-link precision | OPEN | no sheet generated and never measured |
| Five-repo test set including one unknown | PASS | 3 precomputed plus flask, express, click, cobra, React, Next.js |
| Failure cases | PASS | huge repo, no imports (Go, tier 1), private or missing repo, rate limit (HTTP 429 handled), invalid input |
| Cold start on NitroCloud reloads the shipped snapshot | PASS | live `build_graph` for tsoa returned in 3.3 s from the shipped file |

## Deployment (guidebook 6)

Live URL probed on 2026-10-17:
- **Answers**, serves the 12 tools, and loads the shipped snapshots (`npm run verify:server` against it: 45 of 47 checks pass). `build_graph`, `key_files` and `tour_next` work (the tour returns a 25-node graph).
- **`export_guide` fails live**: "EXPORT_SECRET must be set to a secret of at least 16 characters". `ping_repoatlas` shows `exportSecretConfigured: false` and an empty `runtimeMode`, so the dashboard variables are not reaching the server (missing, empty, or saved after the last deploy).
- **It is an older build**: no on-demand repo builds, and asking for an unknown repo returns the old "snapshot mode" message.

## Submission package (guidebook 8.2)

| Item | Status |
|---|---|
| Project name | PASS: RepoAtlas |
| Original product | PASS: GitHub |
| Short explanation of the reimagined workflow | PASS: README and blueprint section 17 |
| GitHub repository, public, with a brief README | PARTIAL: public (API returns 200) and the README has what it does, setup, tools, accuracy and limits, **but the remote is 32 commits behind** (`origin/main` is `2952590`, local is `391d46e`) |
| Demo video | OPEN |
| Live demo URL | PARTIAL: see Deployment |
| LinkedIn post tagging the official MCP to the Moon handle (and any partner community) | OPEN: not drafted; `docs/LINKEDIN_POST.md` does not exist. The exact handles must come from you or the event |
| Phase 9 documents (`DEMO_SCRIPT.md`, `LINKEDIN_POST.md`, `SUBMISSION.md`) | OPEN: not written |

## Recorded deviations from the blueprint (all intentional)

| Blueprint says | What was built | Why |
|---|---|---|
| Controllers with shared prefixes | plain `@Injectable` tool classes (D5) | prefixes rename tools; the 12 names must be exact |
| tree-sitter for Python | regex import scan | NitroCloud is arm64 with no native modules (`SPIKE.md`) |
| Clone on the server with `git` | precomputed snapshots plus on-demand builds from GitHub's archive (D11, D18) | no `git` on NitroCloud |
| Per-user OAuth, ETag requests, `github-oauth.guard.ts` | none | public data only; precomputed repos make no runtime calls; documented in `API_BUDGET.md` |
| One-time confirm token | stateless HMAC token, 10 minutes, bound to the exact draft (D16) | one-time use needs storage; replay only re-returns the same text |
| Session budget of about 30 calls, shown in tool output | 1,500 an hour, enforced, **not shown in output** | generous default so judges are not blocked; showing it in output is a small gap |
| Docs crawl and `external_context` | not built | the blueprint's own first cut |
| Python parsing, widget extras | cut or reduced | as above |

## Found and fixed during this review

- `docs/API_BUDGET.md` still said the server makes no runtime GitHub calls; corrected for on-demand builds.
- Navbar reduced to How it works, Tool explorer, Connect, GitHub and Live demo; body font changed to Inter at a larger size.

## What is left, in order

1. **Redeploy** `repoatlas.zip` and **set `EXPORT_SECRET`** (16+ characters) in the NitroCloud MCP environment variables; confirm with `ping_repoatlas` (`exportSecretConfigured: true`, `liveBuilds: true`). Optional: `GITHUB_TOKEN` (read-only, no scopes).
2. **Push** to GitHub so the public repo matches.
3. **Test the live URL** from another network, in NitroChat, and as a connector in Claude or ChatGPT.
4. **Run each tool once in NitroStudio**, including `key_files`, `explain_file` and the widget.
5. **Record the demo video** (script to be drafted) and **post on LinkedIn** with the official MCP to the Moon handle.
6. **Fill the three hand-check sheets**, or state in the submission that they were not measured.
7. Submit once, when everything above is final (submissions lock).
