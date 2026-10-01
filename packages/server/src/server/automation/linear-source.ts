import { z } from "zod";

// Linear poll source: GraphQL `issues` query ordered by creation, filtered
// client-side to "recently created" for issue_created, plus assignee matching
// for assigned. MonoCode's linear.rs owns the same query shape; this module
// keeps only what the poller needs (no teams/details/threads).

const LINEAR_API = "https://api.linear.app/graphql";
const LINEAR_TIMEOUT_MS = 20_000;

export interface LinearPollSourceOptions {
  apiKey: string;
  timeoutMs?: number;
}

export interface LinearSourceIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  body: string | null;
  labels: string[];
  author: string;
  assignees: string[];
  teamKey: string;
  teamName: string;
  createdAt: string;
  updatedAt: string;
}

const LinearIssuesResponseSchema = z.object({
  data: z
    .object({
      issues: z
        .object({
          nodes: z.array(
            z.object({
              id: z.string(),
              identifier: z.string(),
              title: z.string().catch(""),
              url: z.string().catch(""),
              description: z.string().nullable().catch(null),
              createdAt: z.string().catch(""),
              updatedAt: z.string().catch(""),
              creator: z
                .object({ name: z.string().catch("") })
                .nullable()
                .catch(null),
              assignees: z
                .object({
                  nodes: z.array(z.object({ name: z.string().catch("") }).catch({ name: "" })),
                })
                .nullable()
                .catch(null),
              labels: z
                .object({
                  nodes: z.array(z.object({ name: z.string().catch("") }).catch({ name: "" })),
                })
                .nullable()
                .catch(null),
              team: z
                .object({ key: z.string().catch(""), name: z.string().catch("") })
                .nullable()
                .catch(null),
            }),
          ),
        })
        .catch({ nodes: [] }),
    })
    .nullable()
    .catch(null),
});

const RECENT_ISSUES_QUERY = `query AutomationPoll($first: Int!) {
  issues(first: $first, orderBy: createdAt) {
    nodes {
      id identifier title url description createdAt updatedAt
      creator { name }
      assignees { nodes { name } }
      labels { nodes { name } }
      team { key name }
    }
  }
}`;

async function graphql(
  query: string,
  variables: Record<string, unknown>,
  options: LinearPollSourceOptions,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LINEAR_TIMEOUT_MS);
  try {
    const response = await fetch(LINEAR_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: options.apiKey.trim(),
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Linear API returned HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export async function listLinearRecentIssues(
  options: LinearPollSourceOptions,
  limit = 50,
): Promise<LinearSourceIssue[]> {
  const raw = await graphql(
    RECENT_ISSUES_QUERY,
    { first: Math.min(Math.max(limit, 1), 100) },
    options,
  );
  const parsed = LinearIssuesResponseSchema.parse(raw);
  const nodes = parsed.data?.issues.nodes ?? [];
  return nodes.map((node) => ({
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    body: node.description,
    labels: (node.labels?.nodes ?? []).map((label) => label.name).filter((name) => name.trim()),
    author: node.creator?.name ?? "",
    assignees: (node.assignees?.nodes ?? []).map((user) => user.name).filter((name) => name.trim()),
    teamKey: node.team?.key ?? "",
    teamName: node.team?.name ?? "",
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  }));
}

export function linearConfigured(apiKey: string | null | undefined): boolean {
  return !!apiKey?.trim();
}
