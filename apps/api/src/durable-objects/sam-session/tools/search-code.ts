/**
 * SAM search_code tool — search code in a project's GitHub repository.
 *
 * Uses the GitHub Code Search API to find code matching a query within the
 * project's repository. Requires the user to have GitHub credentials configured.
 */
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import type { AnthropicToolDef, ToolContext } from '../types';
import { getUserGitHubToken, parseRepository, resolveProjectWithOwnership } from './helpers';

/** Default search result limit. Override via SAM_CODE_SEARCH_LIMIT. */
const DEFAULT_LIMIT = 10;
/** Max search result limit. Override via SAM_CODE_SEARCH_MAX_LIMIT. */
const DEFAULT_MAX_LIMIT = 30;
/** GitHub API timeout. Override via SAM_GITHUB_TIMEOUT_MS. */
const DEFAULT_GITHUB_TIMEOUT_MS = 10_000;

export const searchCodeDef: AnthropicToolDef = {
  name: 'search_code',
  description:
    'Search for code in a project\'s GitHub repository. ' +
    'Use this to find specific functions, classes, patterns, or configuration in the codebase. ' +
    'Requires GitHub credentials to be configured in Settings.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID whose repository to search.',
      },
      query: {
        type: 'string',
        description:
          'Search query. Can include GitHub code search qualifiers like language:typescript or path:src/.',
      },
      path: {
        type: 'string',
        description: 'Optional: filter results to files within this directory path.',
      },
      extension: {
        type: 'string',
        description: 'Optional: filter by file extension (e.g. "ts", "go", "md").',
      },
      limit: {
        type: 'number',
        description: `Max results to return. Defaults to ${DEFAULT_LIMIT}, max ${DEFAULT_MAX_LIMIT}.`,
      },
    },
    required: ['projectId', 'query'],
  },
};

export async function searchCode(
  input: {
    projectId: string;
    query: string;
    path?: string;
    extension?: string;
    limit?: number;
  },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }
  if (!input.query?.trim()) {
    return { error: 'query is required.' };
  }

  const env = ctx.env as unknown as Env;

  // Verify ownership
  const project = await resolveProjectWithOwnership(input.projectId.trim(), ctx);
  if (!project) {
    return { error: 'Project not found or not owned by you.' };
  }

  if (!project.repository) {
    return { error: 'No repository configured for this project.' };
  }

  const parsed = parseRepository(project.repository);
  if (!parsed) {
    return { error: 'Invalid repository format.' };
  }

  // Resolve GitHub token
  const ghToken = await getUserGitHubToken(ctx.userId, env);
  if (!ghToken) {
    return {
      status: 'no_credentials',
      note: 'No GitHub token available. Code search requires GitHub credentials in Settings.',
    };
  }

  // Build search query with repo qualifier
  let searchQuery = `${input.query.trim()} repo:${parsed.owner}/${parsed.repo}`;
  if (input.path?.trim()) {
    searchQuery += ` path:${input.path.trim()}`;
  }
  if (input.extension?.trim()) {
    searchQuery += ` extension:${input.extension.trim()}`;
  }

  // Resolve limits
  const maxLimit = Number(env.SAM_CODE_SEARCH_MAX_LIMIT) || DEFAULT_MAX_LIMIT;
  const defaultLimit = Number(env.SAM_CODE_SEARCH_LIMIT) || DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Math.round(input.limit || defaultLimit)), maxLimit);

  const timeoutMs = Number(env.SAM_GITHUB_TIMEOUT_MS) || DEFAULT_GITHUB_TIMEOUT_MS;

  try {
    const apiUrl = `https://api.github.com/search/code?q=${encodeURIComponent(searchQuery)}&per_page=${limit}`;

    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github.text-match+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'SAM/1.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 403) {
      return {
        status: 'rate_limited',
        note: 'GitHub API rate limit exceeded. Try again later.',
      };
    }

    if (res.status === 422) {
      return {
        status: 'invalid_query',
        note: 'GitHub could not process the search query. Try simpler search terms.',
      };
    }

    if (!res.ok) {
      return {
        status: 'api_error',
        note: `GitHub API returned ${res.status}`,
        repository: project.repository,
      };
    }

    const data = (await res.json()) as {
      total_count?: number;
      items?: Array<{
        name: string;
        path: string;
        html_url: string;
        repository?: { full_name: string };
        text_matches?: Array<{
          fragment: string;
          matches: Array<{ text: string; indices: number[] }>;
        }>;
      }>;
    };

    const results = (data.items ?? []).map((item) => ({
      file: item.path,
      name: item.name,
      url: item.html_url,
      matches: item.text_matches?.map((tm) => tm.fragment) ?? [],
    }));

    return {
      results,
      totalCount: data.total_count ?? 0,
      count: results.length,
      query: input.query.trim(),
      repository: project.repository,
    };
  } catch (err) {
    log.warn('sam.search_code.failed', {
      projectId: input.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: 'error',
      note: 'Failed to search code. The GitHub API may be unreachable or the token may be invalid.',
    };
  }
}
