import type { OpenIssue } from './issues.schema.js';
import { scrubEmails } from './privacy.js';

/**
 * GitHub GraphQL queries, response mappers and a minimal fetch-based client. No heavy imports
 * (no simple-git, no octokit), so the deployed server can use it for the optional live issue
 * refresh. The offline engine reaches it through link.service.
 */

export type GraphqlFn = (query: string, variables: Record<string, unknown>) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Minimal GraphQL client over fetch. The token is only sent as an Authorization header. */
export function fetchGraphql(token: string, fetchFn: typeof fetch = fetch): GraphqlFn {
  return async (query, variables) => {
    const res = await fetchFn('https://api.github.com/graphql', {
      method: 'POST',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'repoatlas' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}`);
    const json = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(`GitHub GraphQL error: ${json.errors[0].message.slice(0, 200)}`);
    return json.data;
  };
}

export interface PrData {
  number: number;
  title: string;
  author: string | null;
  mergedAt: string | null;
  reviewers: string[];
  closing: { number: number; title: string; state: string }[];
  files: string[];
}

export const BEGINNER_LABEL = /good[\s_-]*first|first[\s_-]*timers?|help[\s_-]*wanted|beginner|newcomer/i;

export const PR_QUERY = `
query($owner:String!,$name:String!,$first:Int!,$after:String){
  rateLimit{cost remaining resetAt}
  repository(owner:$owner,name:$name){
    description
    primaryLanguage{name}
    defaultBranchRef{name}
    licenseInfo{spdxId}
    pullRequests(first:$first,after:$after,states:MERGED,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title mergedAt
        author{login}
        reviews(first:10){nodes{author{login}}}
        closingIssuesReferences(first:5){nodes{number title state}}
        files(first:30){nodes{path}}
      }
    }
  }
}`;

export const LABELS_QUERY = `
query($owner:String!,$name:String!){
  rateLimit{cost remaining resetAt}
  repository(owner:$owner,name:$name){
    gfi: labels(first:10,query:"good first"){nodes{name}}
    hw: labels(first:10,query:"help wanted"){nodes{name}}
    ft: labels(first:5,query:"first-timer"){nodes{name}}
  }
}`;

export const ISSUES_QUERY = `
query($owner:String!,$name:String!,$first:Int!,$after:String,$labels:[String!]){
  rateLimit{cost remaining resetAt}
  repository(owner:$owner,name:$name){
    issues(first:$first,after:$after,states:OPEN,labels:$labels,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title url body createdAt updatedAt
        author{login} authorAssociation
        labels(first:10){nodes{name}}
        assignees(first:5){nodes{login}}
        comments(last:5){totalCount nodes{author{login} authorAssociation createdAt body}}
        timelineItems(first:20,itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){
          nodes{
            __typename
            ... on CrossReferencedEvent{willCloseTarget source{__typename ... on PullRequest{number state isDraft}}}
            ... on ConnectedEvent{subject{__typename ... on PullRequest{number state isDraft}}}
          }
        }
      }
    }
  }
}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapPr(n: any): PrData {
  const author: string | null = n.author?.login ?? null;
  const reviewers = [...new Set<string>((n.reviews?.nodes ?? []).map((r: any) => r?.author?.login).filter(Boolean))].filter((l) => l !== author);
  return {
    number: n.number,
    title: scrubEmails(String(n.title ?? '')).slice(0, 200),
    author,
    mergedAt: n.mergedAt ?? null,
    reviewers,
    closing: (n.closingIssuesReferences?.nodes ?? []).map((i: any) => ({ number: i.number, title: scrubEmails(String(i.title ?? '')).slice(0, 200), state: String(i.state ?? '') })),
    files: (n.files?.nodes ?? []).map((f: any) => f.path).filter(Boolean),
  };
}

export function mapIssue(n: any): OpenIssue {
  const linked = new Map<number, OpenIssue['linkedPrs'][number]>();
  for (const t of n.timelineItems?.nodes ?? []) {
    const pr = t?.__typename === 'CrossReferencedEvent' ? t.source : t?.__typename === 'ConnectedEvent' ? t.subject : null;
    if (pr?.__typename !== 'PullRequest') continue;
    const prev = linked.get(pr.number);
    linked.set(pr.number, {
      number: pr.number,
      state: String(pr.state ?? ''),
      isDraft: Boolean(pr.isDraft),
      willClose: Boolean(t.willCloseTarget) || Boolean(prev?.willClose),
    });
  }
  return {
    number: n.number,
    title: scrubEmails(String(n.title ?? '')).slice(0, 400),
    url: String(n.url ?? ''),
    body: scrubEmails(String(n.body ?? '')).slice(0, 2000),
    labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
    assignees: (n.assignees?.nodes ?? []).map((a: any) => a.login),
    author: n.author?.login ?? null,
    authorAssociation: String(n.authorAssociation ?? 'NONE'),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    commentCount: n.comments?.totalCount ?? 0,
    comments: (n.comments?.nodes ?? []).map((c: any) => ({
      author: c.author?.login ?? null,
      association: String(c.authorAssociation ?? 'NONE'),
      createdAt: c.createdAt,
      body: scrubEmails(String(c.body ?? '')).slice(0, 400),
    })),
    linkedPrs: [...linked.values()],
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

