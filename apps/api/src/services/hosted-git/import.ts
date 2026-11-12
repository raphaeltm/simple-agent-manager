/**
 * Import a public git repository into a new SAM-hosted repository (self-host only).
 *
 * The Worker fetches the source itself, so the source URL is a server-side request forgery
 * surface: on a self-hosted box the Worker can reach loopback services (celld's operator API,
 * the object store, cloud metadata). Sources are therefore limited to https on port 443 at a
 * fixed allowlist of public forges, with no credentials in the URL. The download is capped at
 * the push cap before anything is stored, and the hosted repository then enforces its own
 * object and storage caps on the push.
 */
import git from 'isomorphic-git';

import { guardedFetch, OutboundRequestRefusedError } from '../../lib/network-hosts/guarded-fetch';
import { errors } from '../../middleware/error';
import { createFetchHttpClient } from '../repo-browse/fetch-http-client';
import { MemoryFS } from '../repo-browse/memory-fs';
import { DEFAULT_HOSTED_GIT_LIMITS } from './limits';

/** Public forges an import may read from. */
export const DEFAULT_HOSTED_GIT_IMPORT_HOSTS: readonly string[] = [
  'github.com',
  'gitlab.com',
  'codeberg.org',
  'bitbucket.org',
];

const DIR = '/import';
type IsoFs = Parameters<typeof git.clone>[0]['fs'];

/** Validate an import URL; returns the normalized https URL or throws a 400. */
export function parseHostedGitImportUrl(
  raw: string,
  allowedHosts: readonly string[] = DEFAULT_HOSTED_GIT_IMPORT_HOSTS
): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw errors.badRequest('importUrl must be an https URL of a public git repository');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.search ||
    url.hash ||
    !allowedHosts.includes(host)
  ) {
    throw errors.badRequest(
      `importUrl must be a public https repository URL on one of: ${allowedHosts.join(', ')}`
    );
  }
  url.hostname = host;
  url.port = '';
  return url.toString();
}

class ImportTooLargeError extends Error {}

/** Every request of an import stays on an allowlisted forge, whatever path git asks for. */
function assertImportHost(url: URL): void {
  if (!DEFAULT_HOSTED_GIT_IMPORT_HOSTS.includes(url.hostname.toLowerCase())) {
    throw new OutboundRequestRefusedError('host', url.hostname, 'import host is not allowlisted');
  }
}

/**
 * A fetch that refuses to download more than `maxBytes` of response bodies in total. The URL is
 * user-chosen, so it goes through the guarded fetch: public https host only, the forge allowlist
 * on every request, and no redirect is ever followed.
 */
function cappedFetch(maxBytes: number): typeof fetch {
  let total = 0;
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input;
    let res: Response;
    try {
      res = await guardedFetch(url, init ?? {}, {
        maxRedirects: 0,
        validateUrl: assertImportHost,
      });
    } catch (err) {
      if (err instanceof OutboundRequestRefusedError && err.reason === 'redirect_limit') {
        throw errors.badRequest('importUrl redirected; use the repository URL it redirects to');
      }
      throw err;
    }
    if (res.status >= 300 && res.status < 400) {
      // A 3xx without a Location header: guardedFetch returns it as the final response.
      throw errors.badRequest('importUrl redirected; use the repository URL it redirects to');
    }
    if (!res.body) return res;
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            controller.error(new ImportTooLargeError('import exceeds the size limit'));
            return;
          }
          controller.enqueue(chunk);
        },
      })
    );
    return new Response(counted, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

/** The source's default branch (HEAD), or null when it cannot be read. */
export async function resolveImportDefaultBranch(sourceUrl: string): Promise<string | null> {
  const http = createFetchHttpClient(cappedFetch(DEFAULT_HOSTED_GIT_LIMITS.maxPushBytes));
  try {
    const refs = await git.listServerRefs({ http, url: sourceUrl, symrefs: true, prefix: 'HEAD' });
    const head = refs.find((ref) => ref.ref === 'HEAD');
    return head?.target?.replace(/^refs\/heads\//, '') ?? null;
  } catch {
    return null;
  }
}

/**
 * Clone `branch` of `sourceUrl` into memory and push it to the hosted repository `remote`.
 * `remoteFetch` reaches the hosted git server in-process (`artifactsRemoteFetch`).
 */
export async function importIntoHostedRepository(params: {
  sourceUrl: string;
  branch: string;
  remote: string;
  token: string;
  remoteFetch: typeof fetch;
}): Promise<void> {
  const fs = new MemoryFS() as unknown as IsoFs;
  const limit = DEFAULT_HOSTED_GIT_LIMITS.maxPushBytes;
  try {
    await git.clone({
      fs,
      http: createFetchHttpClient(cappedFetch(limit)),
      dir: DIR,
      url: params.sourceUrl,
      ref: params.branch,
      singleBranch: true,
      noCheckout: true,
      noTags: true,
    });
  } catch (err) {
    if (err instanceof ImportTooLargeError || (err as Error)?.message?.includes('size limit')) {
      throw errors.badRequest(
        `The repository is larger than the ${Math.round(limit / 1024 / 1024)} MiB import limit for SAM-hosted repositories`
      );
    }
    throw errors.badRequest(
      `Could not read the repository at importUrl: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let result: Awaited<ReturnType<typeof git.push>>;
  try {
    result = await git.push({
      fs,
      http: createFetchHttpClient(params.remoteFetch),
      dir: DIR,
      url: params.remote,
      ref: params.branch,
      remoteRef: `refs/heads/${params.branch}`,
      onAuth: () => ({ username: 'x', password: params.token }),
    });
  } catch (err) {
    throw errors.badRequest(
      `The hosted repository refused the import: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!result.ok) {
    const reason = result.error ?? Object.values(result.refs ?? {}).find((r) => r.error)?.error;
    throw errors.badRequest(
      `The hosted repository refused the import: ${reason ?? 'unknown error'}`
    );
  }
}
