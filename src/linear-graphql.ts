// URN: component:linear-mirror:outbound:LinearGraphql:backend:integration
// Tested-By:
//   - test:linear-mirror:outbound:E001-LINEAR-001-one-way-mirror-fails-closed
// Runtime: bun
// Purpose: Typed outbound-only Linear GraphQL edge for the one-way mirror
//
// The edge only ever issues the five mirror operations. The token is read once
// by the caller and is never stored in config, mappings, receipts, or output.
import { endsWithMarker, markerFor, type OutboundLinear } from "./linear-mirror";

type GraphqlResponse<T> = { data?: T; errors?: Array<{ message?: string }> };
type RemoteNode = { id: string; description?: string; state?: { id?: string }; team?: { id?: string }; project?: { id?: string } };
type Page<N> = { nodes: N[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } };
type Execute = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

/** Safety bound: a mirror that cannot find its marker in this many pages fails closed instead of guessing. */
const maxPages = 100;

/** Issues one GraphQL request and fails closed on any transport or API error. */
function executor(apiKey: string, endpoint: string) {
  return async <T>(query: string, variables: Record<string, unknown>) => {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ query, variables }),
    });
    const value = await response.json() as GraphqlResponse<T>;
    const reason = value.errors?.map((entry) => entry.message).join("; ") || response.statusText;
    if (!response.ok || value.errors?.length || !value.data) throw new Error(`Linear GraphQL refused outbound projection: ${reason}`);
    return value.data;
  };
}

/** Normalizes a Linear node into the mirror's remote-issue shape. */
const remote = (value: RemoteNode) => ({
  id: value.id, marker: value.description ?? "", state_id: value.state?.id ?? "",
  ...(value.team?.id ? { team_id: value.team.id } : {}), ...(value.project?.id ? { project_id: value.project.id } : {}),
});

/** Walks every page; the first matching node wins, and exhausting the bound fails closed. */
async function firstMatch<N>(fetchPage: (cursor: string | null) => Promise<Page<N> | undefined>, matches: (node: N) => boolean) {
  let cursor: string | null = null;
  for (let pages = 0; pages < maxPages; pages += 1) {
    const page: Page<N> | undefined = await fetchPage(cursor);
    const found = page?.nodes.find(matches);
    if (found || !page?.pageInfo.hasNextPage || !page.pageInfo.endCursor) return found;
    cursor = page.pageInfo.endCursor;
  }
  throw new Error("Linear lookup exceeded its page bound; refusing to guess.");
}

/** Scoped to the authorized team/project; the marker must be the final line of the description. */
async function findScopedIssue(execute: Execute, key: string, route: { team_id: string; project_id: string }) {
  const marker = markerFor(key);
  const found = await firstMatch(async (cursor) => (await execute<{ issues: Page<RemoteNode> }>(queryIssues,
    { marker, teamId: route.team_id, projectId: route.project_id, cursor })).issues,
  (node) => endsWithMarker(node.description, marker) && node.team?.id === route.team_id && node.project?.id === route.project_id);
  return found ? remote(found) : undefined;
}

/** Paginates the whole comment history so a long issue cannot hide an existing projection. */
function findKeyedComment(execute: Execute, issueId: string, key: string) {
  const marker = markerFor(key);
  return firstMatch(async (cursor) => (await execute<{ issue: { comments: Page<{ id: string; body?: string }> } | null }>(queryComments, { id: issueId, cursor })).issue?.comments,
    (node) => endsWithMarker(node.body, marker));
}

const queryIssues = `query MirrorIssue($marker: String!, $teamId: ID!, $projectId: ID!, $cursor: String) { issues(first: 50, after: $cursor, filter: { team: { id: { eq: $teamId } }, project: { id: { eq: $projectId } }, description: { contains: $marker } }) { nodes { id description state { id } team { id } project { id } } pageInfo { hasNextPage endCursor } } }`;
const createIssueMutation = `mutation CreateMirrorIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id description state { id } team { id } project { id } } } }`;
const updateIssueMutation = `mutation UpdateMirrorIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }`;
const queryComments = `query MirrorComment($id: String!, $cursor: String) { issue(id: $id) { comments(first: 100, after: $cursor) { nodes { id body } pageInfo { hasNextPage endCursor } } } }`;
const createCommentMutation = `mutation CreateMirrorComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`;
const inspectIssueQuery = `query InspectMirrorIssue($id: String!) { issue(id: $id) { id description state { id } team { id } project { id } } }`;

/** Builds the outbound adapter; there is deliberately no Linear-to-Flow read path here. */
export function linearGraphql(apiKey: string, endpoint = "https://api.linear.app/graphql"): OutboundLinear {
  if (!apiKey.trim()) throw new Error("LINEAR_API_KEY is required for a live Linear projection.");
  const execute = executor(apiKey, endpoint);
  return {
    findIssueByKey: (key, route) => findScopedIssue(execute, key, route),
    async createIssue(input) {
      const data = await execute<{ issueCreate: { success: boolean; issue?: RemoteNode } }>(createIssueMutation,
        { input: { teamId: input.team_id, projectId: input.project_id, title: input.title, description: input.description, stateId: input.state_id } });
      if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error("Linear did not confirm issue creation.");
      return { ...remote(data.issueCreate.issue), marker: input.marker };
    },
    async updateIssue(input) {
      const data = await execute<{ issueUpdate: { success: boolean; issue?: { id: string } } }>(updateIssueMutation,
        { id: input.id, input: { title: input.title, description: input.description, stateId: input.state_id } });
      if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new Error("Linear did not confirm issue update.");
      return data.issueUpdate.issue;
    },
    findCommentByKey: (issue_id, key) => findKeyedComment(execute, issue_id, key),
    async createComment(input) {
      const data = await execute<{ commentCreate: { success: boolean; comment?: { id: string } } }>(createCommentMutation,
        { input: { issueId: input.issue_id, body: input.body } });
      if (!data.commentCreate.success || !data.commentCreate.comment) throw new Error("Linear did not confirm comment creation.");
      return data.commentCreate.comment;
    },
    async inspectIssue(id) {
      const data = await execute<{ issue: RemoteNode | null }>(inspectIssueQuery, { id });
      return data.issue ? remote(data.issue) : undefined;
    },
  };
}
