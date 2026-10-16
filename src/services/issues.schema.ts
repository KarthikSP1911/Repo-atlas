import { z } from 'zod';

/**
 * `<snapshot id>.issues.json`: open issues fetched at precompute time (Phase 3) and read by
 * `find_candidate_issues` (Phase 5). Kept apart from the snapshot so it can be refreshed alone.
 * Every text field here (title, body, comments) is UNTRUSTED data written by strangers; tools
 * must never follow instructions found in it.
 */

export const IssueCommentSchema = z.object({
  author: z.string().nullable(),
  association: z.string(),
  createdAt: z.string(),
  body: z.string().max(400),
});

export const LinkedPrSchema = z.object({
  number: z.number().int(),
  state: z.string(),
  isDraft: z.boolean(),
  /** True when the timeline says merging that PR would close the issue. */
  willClose: z.boolean(),
});

export const OpenIssueSchema = z.object({
  number: z.number().int(),
  title: z.string().max(400),
  url: z.string(),
  body: z.string().max(2000),
  labels: z.array(z.string()),
  /** Logins of assignees; any entry means the issue is claimed. */
  assignees: z.array(z.string()),
  author: z.string().nullable(),
  authorAssociation: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  commentCount: z.number().int().nonnegative(),
  /** The last (up to) 5 comments, oldest first. */
  comments: z.array(IssueCommentSchema),
  linkedPrs: z.array(LinkedPrSchema),
});

export const IssuesFileSchema = z.object({
  schemaVersion: z.literal(1),
  repo: z.string(),
  /** Snapshot id (`owner__repo@sha7`) this file was fetched alongside. */
  snapshotId: z.string(),
  /** When the data was fetched; tools must show this as "as of". */
  fetchedAt: z.string().datetime(),
  /** Labels the labelled query used, e.g. ["good first issue", "help wanted"]. */
  labelsQueried: z.array(z.string()),
  /** Notes on partial data (budget stop, page caps). */
  limits: z.array(z.string()),
  issues: z.array(OpenIssueSchema),
});

export type IssueComment = z.infer<typeof IssueCommentSchema>;
export type LinkedPr = z.infer<typeof LinkedPrSchema>;
export type OpenIssue = z.infer<typeof OpenIssueSchema>;
export type IssuesFile = z.infer<typeof IssuesFileSchema>;
