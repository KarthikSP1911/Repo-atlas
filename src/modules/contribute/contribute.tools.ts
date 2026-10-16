import { ToolDecorator as Tool, z, ExecutionContext, Injectable } from '@nitrostack/core';
import { CANDIDATES } from '../../config/weights.js';
import { StoreService, SnapshotError } from '../../services/store.service.js';
import { findCandidates, newRefreshState, refreshIssues, type RefreshOutcome } from '../../services/candidates.service.js';
import { buildProfile, githubAccessFromEnv, type GithubAccess } from '../../services/profile.service.js';
import { LevelSchema, ProfileSchema, type Profile } from '../../services/profile.types.js';
import { SNAPSHOT_ID_DESCRIPTION, UNTRUSTED_NOTE, loadIndex, withLimits } from '../../services/tool.util.js';

/**
 * Part B tools that do not need file localization: the contributor profile and the shortlist of
 * open, likely unclaimed issues. The issue list is read from the issues file precomputed next to
 * the snapshot; a live refresh happens only when RUNTIME_MODE=live, a token is set, and budget
 * remains (the deployed NitroCloud server runs in snapshot mode and never calls GitHub).
 */
@Injectable()
export class ContributeTools {
  private readonly refreshState = newRefreshState();

  /** Overridable in tests. A field, not a constructor parameter: NitroStack DI injects every constructor parameter. */
  access: () => GithubAccess = () => githubAccessFromEnv();

  constructor(private readonly store: StoreService) {}

  @Tool({
    name: 'profile_contributor',
    description:
      'Builds the contributor profile the issue tools use: languages (as ids like ts, js, py, go), level, and familiar areas, from what the person states. An optional public GitHub username adds that account\'s primary languages (one query) ONLY when the server runs in live mode; on the deployed snapshot-mode server nothing is read from GitHub and the result says so. States exactly what was read. Ask the person for their languages and level; do not guess them.',
    inputSchema: z.object({
      languages: z.array(z.string().min(1).max(30)).min(1).max(12).describe('Languages the person knows, e.g. ["TypeScript", "Python"]'),
      level: LevelSchema,
      familiarAreas: z.array(z.string().max(40)).max(12).optional().describe('Areas they are comfortable in, e.g. ["api", "tests", "docs", "ui", "database", "cli"]'),
      username: z.string().max(60).optional().describe('Public GitHub username, only if the person offered it'),
    }),
    examples: {
      request: { languages: ['TypeScript'], level: 'intermediate', familiarAreas: ['api', 'tests'] },
      response: {
        profile: { languages: ['ts'], level: 'intermediate', familiarAreas: ['api', 'tests'] },
        readNotes: ['Stated by you: languages ts, level intermediate.'],
        githubCalls: 0,
        next: ['find_candidate_issues(snapshotId, profile)'],
      },
    },
  })
  async profileContributor(input: { languages: string[]; level: 'beginner' | 'intermediate' | 'advanced'; familiarAreas?: string[]; username?: string }, ctx: ExecutionContext) {
    const r = await buildProfile(input, this.access());
    ctx.logger.info('profile_contributor', { languages: r.profile.languages.length, githubCalls: r.githubCalls });
    return { ...r, next: ['find_candidate_issues(snapshotId, profile)'] };
  }

  @Tool({
    name: 'find_candidate_issues',
    description: `Shortlist of open issues a newcomer can plausibly finish, from the issues file fetched when the snapshot was built (state its "as of" date to the user). Hard filters: open, not a pull request, not claimed (no assignee, no linked open PR, no recent "can I take this" style comment), not stale (activity within ${CANDIDATES.staleAfterDays} days), no blocking label (wontfix, blocked, needs-discussion, question, ...), described clearly enough. Soft boosts: good first issue / help wanted / documentation labels and a maintainer saying the issue is wanted. Every issue shows why it passed and the evidence behind "likely unclaimed", which can be wrong. Also reports how many issues each filter removed. Pass the top numbers to localize_issue next. ${UNTRUSTED_NOTE}`,
    inputSchema: z.object({
      snapshotId: z.string().min(1).describe(SNAPSHOT_ID_DESCRIPTION),
      profile: ProfileSchema.optional().describe('Profile from profile_contributor; used to flag issues that mention other languages'),
      limit: z.number().int().min(1).max(25).default(10).describe('How many candidates to return'),
      refresh: z.boolean().default(false).describe('Try to re-fetch issues from GitHub. Works only when the server runs in live mode with a token; otherwise the precomputed issues are used'),
    }),
    examples: {
      request: { snapshotId: 'lukeautry__tsoa@f0f9aa7', limit: 3 },
      response: {
        issuesAsOf: '2026-10-16T19:50:59.394Z',
        source: 'snapshot-file',
        considered: 97,
        candidates: [
          {
            number: 1234,
            title: 'Support nullable enums in generated spec',
            url: 'https://github.com/lukeautry/tsoa/issues/1234',
            labels: ['good first issue'],
            reasonsPassed: ['open issue (not a pull request)', 'not claimed: no assignee, no linked open PR, no recent "can I take this" style comment in the last 5 comments', 'active 12 days ago (limit 365)', 'no blocking label', 'clear enough: description of 420 characters, reproduction steps'],
            claim: { label: 'likely unclaimed', evidence: ['no assignee, no linked open PR, no recent "can I take this" style comment in the last 5 comments'] },
            clarity: { score: 0.65, signals: ['description of 420 characters', 'reproduction steps'] },
            freshness: { score: 0.93, daysSinceActivity: 12 },
            boosts: { labels: ['good first issue'], maintainerWanted: false },
            rankScore: 0.6,
            commentCount: 2,
            updatedAt: '2026-10-04T10:00:00Z',
          },
        ],
        excluded: { claimed: 20, maybeFixed: 3, stale: 31, blocked: 5, unclear: 12 },
        localizeNext: [1234],
        nextSteps: ['localize_issue(snapshotId, issueNumber) for each of localizeNext', 'score_first_change(snapshotId, issueNumber, profile)'],
      },
    },
  })
  async findCandidateIssues(input: { snapshotId: string; profile?: Profile; limit?: number; refresh?: boolean }, ctx: ExecutionContext) {
    const idx = await loadIndex(this.store, input.snapshotId);
    let file;
    try {
      file = await this.store.loadIssues(idx.id);
    } catch (e) {
      if (e instanceof SnapshotError) throw new Error(e.message);
      throw e;
    }
    if (!file) {
      return withLimits(idx.snap, {
        issuesAsOf: null,
        source: 'none',
        considered: 0,
        candidates: [],
        excluded: { claimed: 0, maybeFixed: 0, stale: 0, blocked: 0, unclear: 0 },
        excludedExamples: [],
        localizeNext: [],
        note: `No issues file was precomputed for ${idx.id}, so there are no open issues to shortlist. This server does not fetch issues on demand.`,
        nextSteps: [],
      });
    }

    let outcome: RefreshOutcome = { issues: file.issues, fetchedAt: file.fetchedAt, source: 'snapshot-file' };
    let refreshNote: string | undefined;
    if (input.refresh) {
      const access = this.access();
      if (access.enabled && access.gql) {
        outcome = await refreshIssues(idx.repo, file, access.gql, this.refreshState);
        refreshNote = outcome.note;
      } else {
        refreshNote = `Live refresh is off on this server (snapshot mode), so the issues are as of ${file.fetchedAt}.`;
      }
    }
    ctx.logger.info('find_candidate_issues', { id: idx.id, source: outcome.source });

    const result = findCandidates({ issues: outcome.issues, fetchedAt: outcome.fetchedAt }, input.profile, input.limit ?? 10);
    return withLimits(idx.snap, {
      issuesAsOf: outcome.fetchedAt,
      source: outcome.source,
      ...(refreshNote ? { refreshNote } : {}),
      labelsQueried: file.labelsQueried,
      ...result,
      localizeNext: result.candidates.slice(0, CANDIDATES.localizeTop).map((c) => c.number),
      claimNote: '"likely unclaimed" is based on GitHub data only (assignees, linked PRs, the last 5 comments). Someone may still be working on an issue off GitHub, so suggest the person comments to ask before starting.',
      nextSteps: ['localize_issue(snapshotId, issueNumber) for each of localizeNext', 'score_first_change(snapshotId, issueNumber, profile)'],
      ...(file.limits.length ? { issueDataLimits: file.limits } : {}),
    });
  }
}
