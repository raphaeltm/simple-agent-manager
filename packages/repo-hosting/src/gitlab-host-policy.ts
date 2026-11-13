/**
 * Which GitLab host SAM may talk to, and how a refused GitLab request reaches the client.
 *
 * The host is a superadmin setting (`integration.gitlab.host`). A host on the private network
 * (a self-managed GitLab on the LAN, or on this box) is a separate decision from "it is the
 * configured host": it needs `integration.gitlab.allowPrivateNetwork`, like the LLM endpoint's
 * `llm.openAICompatible.allowPrivateNetwork`. Metadata and link-local hosts are refused always.
 * Used by the GitLab API client (gitlab.ts) and the GitLab sign-in provider
 * (gitlab-login-provider.ts), so both refuse the same hosts.
 */
import { classifyHost, OutboundRequestRefusedError } from '@simple-agent-manager/worker-core';
import { AppError } from '@simple-agent-manager/worker-core';

/** One deadline for a whole GitLab call, redirect hops included (GITLAB_API_TIMEOUT_MS). */
export const DEFAULT_GITLAB_API_TIMEOUT_MS = 30_000;

export type GitLabHostVerdict = 'allowed' | 'private_not_allowed' | 'forbidden';

export function gitLabHostVerdict(host: string, allowPrivateNetwork: boolean): GitLabHostVerdict {
  let hostname: string;
  try {
    hostname = new URL(host).hostname;
  } catch {
    return 'forbidden';
  }
  const hostClass = classifyHost(hostname);
  if (hostClass === 'forbidden') return 'forbidden';
  if (hostClass === 'private' && !allowPrivateNetwork) return 'private_not_allowed';
  return 'allowed';
}

/** Throws a 400 the admin can act on unless SAM may call `host`. */
export function assertGitLabHostAllowed(host: string, allowPrivateNetwork: boolean): void {
  const verdict = gitLabHostVerdict(host, allowPrivateNetwork);
  if (verdict === 'private_not_allowed') {
    throw new AppError(
      400,
      'GITLAB_PRIVATE_NETWORK_NOT_ALLOWED',
      'The configured GitLab host is on a private network address. Turn on integration.gitlab.allowPrivateNetwork in admin settings (OAuth) to allow it.'
    );
  }
  if (verdict === 'forbidden') {
    throw new AppError(
      400,
      'GITLAB_HOST_NOT_ALLOWED',
      'The configured GitLab host is a metadata, link-local or reserved address and cannot be used.'
    );
  }
}

/**
 * A GitLab request the guarded fetch refused mid-flight (a redirect to a refused host, too many
 * redirects, a streamed body it would have to replay, or the deadline) as a client error with a
 * stable code. GitLab, not the caller, is misbehaving, so 502; a deadline is 504. Anything else is
 * returned unchanged for the caller to rethrow.
 */
export function gitLabRequestError(err: unknown): unknown {
  if (!(err instanceof OutboundRequestRefusedError)) return err;
  if (err.reason === 'deadline') {
    return new AppError(504, 'GITLAB_TIMEOUT', 'GitLab did not answer in time.');
  }
  return new AppError(
    502,
    'GITLAB_REQUEST_REFUSED',
    `SAM refused to follow GitLab's response (${err.reason}). Check that the configured GitLab host is the final address and does not redirect elsewhere.`
  );
}
