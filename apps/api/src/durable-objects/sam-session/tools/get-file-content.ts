/**
 * SAM get_file_content tool — retrieve file content from a project's GitHub repository.
 *
 * Uses the GitHub Contents API to fetch file content or directory listings.
 * Requires the user to have GitHub credentials configured.
 */
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import type { AnthropicToolDef, ToolContext } from '../types';
import { getUserGitHubToken, parseRepository, resolveProjectWithOwnership } from './helpers';

/** Max file size in bytes. Override via SAM_FILE_CONTENT_MAX_BYTES. */
const DEFAULT_MAX_BYTES = 1_048_576; // 1 MB
/** GitHub API timeout. Override via SAM_GITHUB_TIMEOUT_MS. */
const DEFAULT_GITHUB_TIMEOUT_MS = 10_000;

export const getFileContentDef: AnthropicToolDef = {
  name: 'get_file_content',
  description:
    'Get the content of a file or directory listing from a project\'s GitHub repository. ' +
    'Use this to read specific source files, configs, or browse directory structures. ' +
    'For files, returns the decoded content. For directories, returns a listing of entries. ' +
    'Requires GitHub credentials to be configured in Settings.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID whose repository to read from.',
      },
      path: {
        type: 'string',
        description:
          'File or directory path within the repository (e.g. "src/index.ts" or "packages/shared").',
      },
      ref: {
        type: 'string',
        description:
          'Optional: branch, tag, or commit SHA to read from. Defaults to the project\'s default branch.',
      },
    },
    required: ['projectId', 'path'],
  },
};

export async function getFileContent(
  input: { projectId: string; path: string; ref?: string },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }
  if (!input.path && input.path !== '') {
    return { error: 'path is required.' };
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
      note: 'No GitHub token available. File access requires GitHub credentials in Settings.',
    };
  }

  const ref = input.ref?.trim() || project.defaultBranch || 'main';
  const filePath = input.path.trim().replace(/^\/+/, ''); // strip leading slashes

  const timeoutMs = Number(env.SAM_GITHUB_TIMEOUT_MS) || DEFAULT_GITHUB_TIMEOUT_MS;
  const maxBytes = Number(env.SAM_FILE_CONTENT_MAX_BYTES) || DEFAULT_MAX_BYTES;

  try {
    const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`;

    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'SAM/1.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 404) {
      return {
        status: 'not_found',
        note: `File or directory not found: ${filePath} (ref: ${ref})`,
        repository: project.repository,
      };
    }

    if (!res.ok) {
      return {
        status: 'api_error',
        note: `GitHub API returned ${res.status}`,
        repository: project.repository,
      };
    }

    const data = await res.json();

    // Directory listing (array response)
    if (Array.isArray(data)) {
      const entries = (data as Array<{ name: string; path: string; type: string; size: number }>).map(
        (entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type, // 'file' | 'dir' | 'symlink' | 'submodule'
          size: entry.type === 'file' ? entry.size : undefined,
        }),
      );

      return {
        type: 'directory',
        path: filePath || '/',
        ref,
        entries,
        count: entries.length,
        repository: project.repository,
      };
    }

    // Single file response
    const fileData = data as {
      name: string;
      path: string;
      size: number;
      type: string;
      content?: string;
      encoding?: string;
    };

    if (fileData.type !== 'file') {
      return {
        status: 'unsupported_type',
        note: `Path is a ${fileData.type}, not a file. Use a directory path to list contents.`,
      };
    }

    if (fileData.size > maxBytes) {
      return {
        status: 'file_too_large',
        note: `File is ${fileData.size} bytes, exceeding the ${maxBytes} byte limit.`,
        path: fileData.path,
        size: fileData.size,
      };
    }

    // Decode base64 content
    let content = '';
    if (fileData.content && fileData.encoding === 'base64') {
      try {
        content = atob(fileData.content.replace(/\n/g, ''));
      } catch {
        return {
          status: 'decode_error',
          note: 'Failed to decode file content. The file may be binary.',
          path: fileData.path,
        };
      }
    } else if (fileData.content) {
      content = fileData.content;
    }

    return {
      type: 'file',
      path: fileData.path,
      name: fileData.name,
      ref,
      size: fileData.size,
      content,
      repository: project.repository,
    };
  } catch (err) {
    log.warn('sam.get_file_content.failed', {
      projectId: input.projectId,
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: 'error',
      note: 'Failed to fetch file content. The GitHub API may be unreachable or the token may be invalid.',
    };
  }
}
