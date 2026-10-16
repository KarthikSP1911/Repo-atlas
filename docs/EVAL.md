# Evaluation

Everything here was measured, not estimated, on the three shipped demo snapshots: `lukeautry/tsoa` (TS, tier 2), `pwndbg/pwndbg` (Python, tier 2) and `go-git/go-git` (Go, tier 1). Reproduce with `npm run eval` (needs `GITHUB_TOKEN` once, for issue bodies). Raw results are in [`docs/eval/`](eval/). Sample sizes are small, so treat the percentages as indications, not precise rates.

## Summary

| Check | Result | Status |
|---|---|---|
| Localization hit@5 on 49 merged PRs, using only the issue text | **69%** (95% interval about 56% to 81%), recall@5 49%, MRR 0.60. Random 6%, top-5-by-fan-in 24% | measured |
| Key-file overlap with the maintainers' own docs | **Not scorable**: the three repos' docs name 0 to 2 rankable files | measured: not possible |
| Key files judged by a person | sheet generated, 29 files | **waiting for hand-check** |
| Candidate issue quality (top 10 on tsoa) | sheet generated | **waiting for hand-check** |
| Claim detection (20 "likely unclaimed" issues) | sheet generated | **waiting for hand-check** |
| GitHub API use | 5 to 6 calls per repo build, 0 per tool call | measured |

## 1. Localization (`localize_issue`): hit@5 backtest

**Question:** given only an issue's title and body, is a file that the real fixing PR changed in the top 5?

**Method.** For each merged PR that has an exact (GitHub-confirmed) link to an issue and changed 1 to 8 non-test files that still exist, the snapshot is rewound to a week before the PR was opened: only PRs merged and commits dated before that point are kept, and each file's "last changed" date is recomputed from those commits. The issue text is fetched from GitHub (title and body). The result is a hit if any real changed file is in the top 5. Up to 20 PRs per repo, newest first, preferring first-time contributors.

| Variant | hit@5 | recall@5 | MRR |
|---|---|---|---|
| **Default weights** (text 0.45, history 0.30, graph 0.15, recency 0.10) | **69%** | 49% | 0.60 |
| Text match only | 63% | 45% | 0.52 |
| History similarity only | 53% | 33% | 0.33 |
| Text + history, no graph or recency | 73% | 48% | 0.58 |
| Recency only | 29% | 18% | 0.16 |
| Baseline: 5 files with the highest fan-in | 24% | 15% | 0.15 |
| Baseline: 5 random files (expected) | 6% | n/a | n/a |

n = 49 PRs. The default beats both trivial baselines by a wide margin, and each signal on its own is weaker than the combination.

| Repo | n | hit@5 | recall@5 | MRR | random |
|---|---|---|---|---|---|
| `pwndbg/pwndbg` (Python, tier 2) | 16 | 81% | 52% | 0.73 | 2% |
| `lukeautry/tsoa` (TS, tier 2) | 20 | 75% | 59% | 0.60 | 12% |
| `go-git/go-git` (Go, tier 1: no import graph) | 13 | 46% | 31% | 0.44 | 3% |

The Tier 1 repo is clearly worse (46%). That is expected: it has no graph proximity signal, and Go paths and symbols carry less of the issue vocabulary. By PR author: contributors 65% (n=37), maintainers 83% (n=12).

**Caveats, in order of how much they matter**

1. **No first-timer PRs.** Of the 49 PRs, none came from GitHub-labelled first-time contributors (37 are other non-maintainer contributors, 12 are maintainers). The sample matches the requested kind of PR only loosely, and the task of "a newcomer's first issue" may be harder or easier than these.
2. **Optimistic text signal.** File names, symbols and docstrings come from today's code and cannot be rewound, so a symbol added by the fixing PR can match the issue text. History and recency are rewound correctly. The true rate is probably somewhat lower than 69%.
3. **Selection.** Only PRs with an exact issue link and at most 8 changed files qualify; that is 13 of 100 PRs for go-git, 41 for tsoa and 16 for pwndbg. Large changes are not tested.
4. **Small samples.** With n = 49 the 95% interval is about 56% to 81%; per repo it is much wider.

### Weight tuning

The four weights live in `src/config/weights.ts`. A grid search (step 0.05) with 2-fold cross-validation (folds by PR number parity):

| | hit@5 | MRR |
|---|---|---|
| Default weights, all 49 PRs | 69% | 0.60 |
| **Tuned, cross-validated (held out)** | **69%** | 0.57 |
| Best on all PRs (in-sample, optimistic) | 78% | 0.60 |

Weights tuned on one half and scored on the other half did not beat the defaults (70% vs 67% on one fold, 68% vs 73% on the other), so **the blueprint weights were kept unchanged**. The 78% in-sample figure comes from fitting 49 PRs and should not be quoted as accuracy. One observation for later: dropping graph proximity and recency (text 0.6, history 0.4) scored 73%, which is within noise of 69% at this sample size.

## 2. Key files (`key_files`)

**Planned check:** overlap between the Must read tier and the files the repo's own CONTRIBUTING, ARCHITECTURE or README name.

**Result: not scorable.** The snapshot links a doc to a file only on an exact path match. The three repos' docs name almost no files that way:

| Repo | Files named by maintainer docs | Rankable code or config files among them | Folders named |
|---|---|---|---|
| `lukeautry/tsoa` | 0 | 0 | 0 |
| `pwndbg/pwndbg` | 3 | 2 | 0 |
| `go-git/go-git` | 4 | 2 | 0 |

With fewer than 3 files an overlap percentage means nothing, so none is reported. Instead `docs/eval/handcheck-keyfiles.csv` lists the top 10 Must read files for each repo (29 rows) with a blank column for a person to answer "would a maintainer call this essential?". That gives a precision figure once filled in. Counts for the record: the Must read tier is 10% of candidate files, and the formula's weights are the blueprint's (`KEY_FILES` in `weights.ts`); they were not tuned because there is no ground truth to tune against.

## 3. Candidate issues (`find_candidate_issues`)

What the filters did to each repo's open issues (precomputed on 2026-10-16, issues file as-of that date; stale means no activity for 365 days):

| Repo | Considered | Passed | Stale | Blocked label | Claimed | Unclear | Beginner-labelled among all / among passed |
|---|---|---|---|---|---|---|---|
| `pwndbg/pwndbg` | 95 | 60 | 26 | 1 | 8 | 0 | 54 / 23 |
| `go-git/go-git` | 92 | 52 | 24 | 9 | 7 | 0 | 50 / 18 |
| `lukeautry/tsoa` | 97 | 15 | 79 | 3 | 0 | 0 | 80 / 6 |

Two honest observations. First, the "clear enough" filter removed nothing: its bar (a description of at least 40 characters) is low by design ("ideally with a repro"), so it is effectively not a filter yet. Second, tsoa shows 0 claimed issues because none of its sampled issues has an assignee, an open linked PR or a claim-style comment in the last five. Both facts are only checkable by a person, which is what the sheets are for:

- `docs/eval/handcheck-candidates.csv`: the top 10 tsoa candidates. Questions: is it really open, really unclaimed, reasonable for a newcomer?
- `docs/eval/handcheck-claims.csv`: 20 issues labelled "likely unclaimed" across the three repos. Question: is the label right?

**Not measured yet:** the share of top-10 candidates that are truly open, unclaimed and reasonable, and how often the "likely unclaimed" label is right. Those two numbers come from the sheets.

## 4. API usage

From `docs/API_BUDGET.md`: a repo build takes 5 or 6 GraphQL calls (cost 9 to 11 points of the 5,000 per hour), and the three demo builds took 17 calls in total. Every tool call on the server makes **zero** GitHub calls (snapshot mode). The backtest needed 4 calls (cost 4) to fetch issue bodies. The server never reads a token.

## 5. Failure cases from the blueprint

| Case | How it is handled | Evidence |
|---|---|---|
| Huge repo over the file cap | Partial graph, `truncated: true`, warning | `tests/build.service.test.ts` (cap of 3 files); file cap 1,500 |
| Repo with no imports | Tier 1: tools degrade with explicit notices | go-git results above; `tests/tour.service.test.ts`, `flow.service.test.ts` |
| Private repo without auth | Not applicable: snapshot mode only serves precomputed public repos; unknown repos return `status: "unavailable"` with the list | `tests/overview.service.test.ts` |
| Rate limit hit | Build stops early and says so; live refresh falls back to the file with an "as of" note | `tests/link.service.test.ts`, `tests/candidates.service.test.ts` |
| Empty docs site | Docs links are simply absent (tsoa has none) | tsoa snapshot |
| Snapshot older than the latest SHA | Every result carries `asOf`, the commit and a "may have changed since" note | `limits` in every tool |
| Cold start on NitroCloud | Needs the deployed server | **waiting for deploy** |

## 6. What is not covered

- No hand-checked accuracy yet for key files, candidate quality or claim detection (sheets are ready).
- Docs-to-code link precision was not measured. Only exact path matches are shown by default.
- `tour_next` check questions were not evaluated for usefulness with real users.
- Everything above is on 3 repos; other repos, languages and sizes are untested.
