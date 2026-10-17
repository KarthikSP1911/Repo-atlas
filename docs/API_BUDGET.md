# GitHub API budget

All numbers are real, logged by `npm run precompute` (the script prints them per repo). Authenticated GraphQL has 5,000 points per hour; for the **precomputed** repos the server makes **zero** GitHub calls at runtime, so that budget only matters on the developer machine. Repos built on demand (D18) do make runtime calls; see the last section.

## What one repo build costs

| Call | Purpose | GraphQL cost |
|---|---|---|
| `prs#1`, `prs#2` | Last 100 merged PRs (50 per page): author, reviewers, closing issues, up to 30 files each | 2 + 2 |
| `labels` | Which beginner-style labels exist (`good first`, `help wanted`, `first-timer`); fuzzy results are filtered strictly | 1 |
| `issues:labelled#1..2` | Open issues carrying those labels (50 per page, up to 2 pages): body, labels, assignees, last 5 comments, cross-references | 2 each |
| `issues:recent#1` | One page of the most recently updated open issues, deduplicated | 2 |

The clone, `git log --name-only`, import parsing and all metrics cost **no** API calls. Limits in code: 30 calls per run, stop early below 100 remaining points, never loop, at most 150 open issues per repo.

## Final run for the shipped snapshots (2026-10-16)

| Snapshot | Calls | Cost (points) | Remaining after | Merged PRs | Open issues | Size |
|---|---|---|---|---|---|---|
| `lukeautry__tsoa@f0f9aa7` | 6 | 11 | 4,954 | 100 | 97 (80 beginner-labelled) | 438 KB |
| `pwndbg__pwndbg@b5162e6` | 6 | 11 | 4,943 | 100 | 95 (54) | 934 KB |
| `go-git__go-git@87e8ad5` | 5 | 9 | 4,925 | 100 | 92 (50) | 594 KB |

Total for the three: **17 calls, 31 points**, about 0.6% of one hour's allowance. The blueprint estimate was 5 to 10 calls per repo; the real figure is 5 or 6. Each repo took 3 to 41 seconds for `git log` and 13 to 21 seconds for GraphQL (pwndbg's history read is the slowest at about 40 s).

Runs on the way there (development only, results not shipped): a first full run of the three repos (17 calls), a smoke test on `pallets/click` (5 calls, 9 points), a second run of the three after fixing language labels (17 calls), and a go-git rebuild after adding email scrubbing (5 calls). About 44 calls and 80 points in total this session.

## Rate-limit behaviour

- Every response's `rateLimit { cost remaining resetAt }` is read; `remaining` and per-call `cost` are logged in the run report.
- Below 100 remaining points the run stops and records `stoppedReason` in the report and in the issues file's `limits`.
- When the call budget or the rate limit stops a build early, the snapshot is still written with what was read, and the limit is stated in its warnings. (The server then reports the snapshot's `asOf` time to users; it never retries or loops.)

## Not used

- REST `ETag` / conditional requests: not needed, there is no repeated polling.
- Per-user OAuth (blueprint section 6): not implemented. Precomputed repos make no runtime calls, and on-demand builds read only public data with the server's optional read-only token (or none). Per-user tokens would only matter for private repos, which are not supported.

## On-demand builds (D18)

Measured on 2026-10-17 with no token: about 4 REST calls per repo (repo metadata, 100 latest commits, an issue search, plus a fallback page) and one archive download from `codeload.github.com`, which is not part of the API and has no API quota (but is rate-limited per network address, HTTP 429). With a server token: GraphQL for PRs, labels and issues (5 to 7 calls, 12 at most), the changed files of the newest 40 commits (up to 40 calls) and the authenticated archive route (1 call), so about 50 REST requests and a few GraphQL points per repo; at the 40-repos-per-hour cap that is at most about 2,000 of the 5,000 REST requests an hour, plus a few hundred of the 5,000 GraphQL points. Unauthenticated REST allows 60 calls an hour per server address, so roughly 15 builds an hour without a token; the build still succeeds when it is rate limited and says which data is missing.
