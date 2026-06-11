/**
 * Registry v2 protocol parsing: token-auth scope strings and /v2/ URL paths.
 *
 * Scope grammar (docker distribution token spec):
 *   scope = resourcetype ":" resourcename ":" action [ "," action ]*
 * Resource names may themselves contain ":" (e.g. host:port prefixes), so we
 * split on the first and last colon.
 */

export interface ParsedScope {
  type: string;
  name: string;
  actions: string[];
}

export function parseScope(scope: string): ParsedScope | null {
  const first = scope.indexOf(':');
  const last = scope.lastIndexOf(':');
  if (first <= 0 || last <= first || last === scope.length - 1) {
    return null;
  }
  const type = scope.slice(0, first);
  const name = scope.slice(first + 1, last);
  const actions = scope
    .slice(last + 1)
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  if (!name || actions.length === 0) {
    return null;
  }
  return { type, name, actions };
}

/** The repository namespace prefix every repo of a project must live under. */
export function projectNamespace(projectId: string): string {
  return `proj-${projectId.toLowerCase()}/`;
}

export type ParsedV2Path =
  | { kind: 'ping' }
  | { kind: 'catalog' }
  | { kind: 'repository'; repository: string; resource: string }
  | { kind: 'unknown' };

const REPO_RESOURCES = ['manifests', 'blobs', 'tags', 'referrers'] as const;

/**
 * Parse a /v2/... pathname. Repository names contain slashes, so we locate the
 * last occurrence of a known resource segment and treat everything before it
 * as the repository name.
 *
 * Callers must pass `new URL(...).pathname` (WHATWG-normalized): percent
 * sequences like %2e%2e are NOT decoded into path separators/dot-segments by
 * the URL parser, and literal `..` segments are collapsed before this function
 * ever sees them, so traversal cannot move a request out of its namespace.
 */
export function parseV2Path(pathname: string): ParsedV2Path {
  if (pathname === '/v2' || pathname === '/v2/') {
    return { kind: 'ping' };
  }
  if (!pathname.startsWith('/v2/')) {
    return { kind: 'unknown' };
  }
  const rest = pathname.slice('/v2/'.length);
  if (rest === '_catalog') {
    return { kind: 'catalog' };
  }
  const segments = rest.split('/');
  for (let i = segments.length - 1; i > 0; i--) {
    if ((REPO_RESOURCES as readonly string[]).includes(segments[i])) {
      const repository = segments.slice(0, i).join('/');
      if (!repository) {
        return { kind: 'unknown' };
      }
      return { kind: 'repository', repository, resource: segments.slice(i).join('/') };
    }
  }
  return { kind: 'unknown' };
}

/**
 * Map an HTTP method to the registry action it requires.
 *
 * Deliberate: DELETE maps to 'push' rather than a distinct 'delete' action.
 * The proxy never grants 'delete' (token issuance filters to pull/push only),
 * so deletes are gated by push access. If finer-grained delete control is
 * needed in production, add 'delete' to the grant grammar explicitly.
 */
export function requiredAction(method: string): 'pull' | 'push' {
  return method === 'GET' || method === 'HEAD' ? 'pull' : 'push';
}
