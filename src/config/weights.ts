/**
 * Every tunable weight and threshold in one place. Starting values come from the blueprint
 * (section 9); Phase 7 tunes them on the demo repos and records the numbers in docs/EVAL.md.
 */

/** key_files: score = 3*entry + 2*fanInHat + 1.5*config + churnHat + docsMentionsHat + 0.5*tests */
export const KEY_FILES = {
  entry: 3,
  fanIn: 2,
  config: 1.5,
  churn: 1,
  docsMentions: 1,
  tests: 0.5,
  /** Share of candidate files in each tier (Must read, then Read next; the rest is Skip for now). */
  mustReadShare: 0.1,
  readNextShare: 0.25,
} as const;

/** localize_issue: score = a*textMatch + b*historySimilarity + c*graphProximity + d*recency (all parts scaled to 0..1). */
export const LOCALIZE = {
  a: 0.45,
  b: 0.3,
  c: 0.15,
  d: 0.1,
  /** Recency half-life in days: a file changed this long ago counts half as much as one changed today. */
  recencyHalfLifeDays: 180,
  /** Results returned. */
  topFiles: 5,
} as const;

/** find_candidate_issues: hard filters and soft boosts. */
export const CANDIDATES = {
  /** An issue with no activity for this long is stale. */
  staleAfterDays: 365,
  /** Shortest acceptable issue body (characters) to count as clear enough. */
  minBodyChars: 40,
  blockedLabels: ['wontfix', 'blocked', 'needs-discussion', 'needs discussion', 'question', 'duplicate', 'invalid', 'on hold', 'stale', 'wip'],
  boostLabels: ['good first issue', 'good-first-issue', 'help wanted', 'help-wanted', 'documentation', 'beginner', 'first-timers-only', 'easy'],
  /** A comment like "can I take this" within this many days counts as a claim. */
  claimCommentDays: 90,
  /** How many candidates get a localization pass. */
  localizeTop: 5,
  /** Ranking of candidates that passed every hard filter (before localization). */
  rank: { clarity: 0.4, freshness: 0.25, beginnerLabel: 0.2, maintainerWanted: 0.15 },
  /** Open issues are re-fetched at most this often in live mode. */
  refreshCacheMinutes: 10,
  /** Most GitHub calls one process makes for refreshes per hour. */
  refreshCallsPerHour: 12,
} as const;

/**
 * Runtime policies (Phase 6): generous on purpose. They only stop a runaway agent loop on the free
 * tier. Callers that send no session id share one "anonymous" bucket, so the limits must be high
 * enough for several people at once (cached answers are cheap).
 */
export const POLICIES = {
  /** Calls per minute per caller (session) for every read tool. */
  readCallsPerMinute: 120,
  /** export_guide is stricter. */
  exportCallsPerMinute: 20,
  /** Tool calls one caller (session) may make per hour before being asked to wait. */
  sessionCallBudgetPerHour: Number(process.env.SESSION_CALL_BUDGET) > 0 ? Number(process.env.SESSION_CALL_BUDGET) : 1500,
  /** Result cache lifetimes in seconds. Snapshots are immutable per commit, so reads can be cached for a while. */
  cacheSeconds: { graph: 300, overview: 600, analysis: 300, tour: 300, candidates: 60, localize: 300 },
} as const;

/** score_first_change: product of factors, each floored so one weak signal lowers but never zeroes the score. */
export const FIRST_CHANGE = {
  factorFloor: 0.1,
  /** Freshness half-life in days for issue activity. */
  freshnessHalfLifeDays: 120,
  /** Preferred number of files to touch per level: [min, ideal max, hard max before the size factor bottoms out]. */
  sizeByLevel: { beginner: [1, 2, 5], intermediate: [1, 4, 8], advanced: [1, 8, 15] } as Record<string, readonly [number, number, number]>,
} as const;
