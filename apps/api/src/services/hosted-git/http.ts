/**
 * Git smart HTTP for SAM-hosted repositories: `https://api.<BASE_DOMAIN>/git/<repo>.git/...`.
 *
 * Every request is authenticated here before it reaches the repository's Durable Object:
 * 1. HTTP Basic, password = a SAM hosted-git token (`tokens.ts`); the username is ignored.
 * 2. The token names exactly this repository, and a push (receive-pack, including its
 *    `info/refs?service=git-receive-pack` discovery) needs the `write` scope.
 * 3. D1: the repository still belongs to an `artifacts` project. A token minted for a workspace
 *    additionally needs that workspace to be active, on a live node, in that same project.
 * Any failure answers 401 with a Basic challenge (git then reports "Authentication failed"),
 * without saying which check failed.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { nodeStatusTerminatesCallbacks } from '../node-callback-auth';
import { WORKSPACE_CALLBACK_ACTIVE_STATUSES } from '../workspace-callback-identity';
import { isHostedGitRepoName, verifyHostedGitToken } from './tokens';

export const HOSTED_GIT_PATH_PREFIX = '/git/';

/** Durable Object sub-paths a client may reach, with the scope each needs. */
type GitOperation = { doPath: string; write: boolean };

function classify(subPath: string, method: string, url: URL): GitOperation | null {
  if (subPath === '/info/refs' && method === 'GET') {
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') return { doPath: '/info/refs', write: false };
    if (service === 'git-receive-pack') return { doPath: '/info/refs', write: true };
    return null;
  }
  if (subPath === '/git-upload-pack' && method === 'POST') {
    return { doPath: '/git-upload-pack', write: false };
  }
  if (subPath === '/git-receive-pack' && method === 'POST') {
    return { doPath: '/git-receive-pack', write: true };
  }
  return null;
}

/** Parse `/git/<repo>.git/<sub>`; the `.git` suffix is optional. */
export function parseHostedGitPath(pathname: string): { repo: string; subPath: string } | null {
  if (!pathname.startsWith(HOSTED_GIT_PATH_PREFIX)) return null;
  const rest = pathname.slice(HOSTED_GIT_PATH_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const repo = rest.slice(0, slash).replace(/\.git$/, '');
  if (!isHostedGitRepoName(repo)) return null;
  return { repo, subPath: rest.slice(slash) };
}

function unauthorized(): Response {
  return new Response('Authentication required for this SAM-hosted repository\n', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="SAM"', 'content-type': 'text/plain' },
  });
}

function basicPassword(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const colon = decoded.indexOf(':');
    return colon === -1 ? null : decoded.slice(colon + 1);
  } catch {
    return null;
  }
}

interface BindingRow {
  project_id: string;
  workspace_status: string | null;
  workspace_project_id: string | null;
  node_id: string | null;
  node_status: string | null;
}

/** One D1 round trip: the repository's project and, when bound, the token's workspace. */
async function loadBinding(
  env: Pick<Env, 'DATABASE'>,
  repo: string,
  workspaceId: string | undefined
): Promise<BindingRow | null> {
  return env.DATABASE.prepare(
    `SELECT p.id AS project_id,
            w.status AS workspace_status, w.project_id AS workspace_project_id,
            w.node_id AS node_id, n.status AS node_status
       FROM projects p
       LEFT JOIN workspaces w ON w.id = ?2
       LEFT JOIN nodes n ON n.id = w.node_id
      WHERE p.artifacts_repo_id = ?1 AND p.repo_provider = 'artifacts'
      LIMIT 1`
  )
    .bind(repo, workspaceId ?? null)
    .first<BindingRow>();
}

function workspaceBindingAllows(row: BindingRow): boolean {
  if (!row.workspace_status || !WORKSPACE_CALLBACK_ACTIVE_STATUSES.has(row.workspace_status)) {
    return false;
  }
  if (row.workspace_project_id !== row.project_id) return false;
  return !!row.node_id && !!row.node_status && !nodeStatusTerminatesCallbacks(row.node_status);
}

export interface HostedGitHttpEnv {
  DATABASE: D1Database;
  ENCRYPTION_KEY: string;
  HOSTED_GIT?: DurableObjectNamespace;
}

/** Handle one git request. Returns null when the path is not a hosted git path. */
export async function handleHostedGitRequest(
  request: Request,
  env: HostedGitHttpEnv,
  options: {
    /**
     * Set only by SAM's own in-process calls (`artifactsRemoteFetch`): README seeding runs
     * before the project row exists, and browsing callers have already checked project access.
     * The token's signature, repository, scope and expiry are still checked.
     */
    trustedInternalCaller?: boolean;
  } = {}
): Promise<Response | null> {
  const url = new URL(request.url);
  const parsed = parseHostedGitPath(url.pathname);
  if (!parsed) return null;
  if (!env.HOSTED_GIT) return new Response('not found\n', { status: 404 });
  const operation = classify(parsed.subPath, request.method, url);
  if (!operation) return new Response('not found\n', { status: 404 });

  const password = basicPassword(request);
  if (!password) return unauthorized();
  const claims = await verifyHostedGitToken(env, password);
  const reject = (reason: string) => {
    log.info('hosted_git.auth_rejected', { repo: parsed.repo, reason, write: operation.write });
    return unauthorized();
  };
  if (!claims) return reject('invalid_token');
  if (claims.repo !== parsed.repo) return reject('repo_mismatch');
  if (operation.write && claims.scope !== 'write') return reject('scope');

  if (!options.trustedInternalCaller || claims.workspaceId) {
    const binding = await loadBinding(env, parsed.repo, claims.workspaceId);
    if (!binding) return reject('repo_not_bound');
    if (claims.workspaceId && !workspaceBindingAllows(binding)) {
      return reject('workspace_inactive');
    }
  }

  const doUrl = new URL(request.url);
  doUrl.pathname = operation.doPath;
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  const forwarded = new Request(doUrl.toString(), {
    method: request.method,
    headers,
    body: request.method === 'GET' ? null : request.body,
  });
  const stub = env.HOSTED_GIT.get(env.HOSTED_GIT.idFromName(parsed.repo));
  return stub.fetch(forwarded);
}
