/**
 * SAM container-registry proxy (SPIKE).
 *
 * Speaks the registry v2 protocol in front of an upstream registry
 * (production: registry.cloudflare.com — the same registry SAM uses for the
 * devcontainer build cache). Clients authenticate with project-scoped SAM
 * tokens; the proxy enforces the per-project repository namespace
 * (`proj-{projectId}/...`) on every request and swaps in the upstream
 * credential server-side. The upstream credential never leaves SAM.
 *
 * Flow (standard docker token auth):
 *   1. Client hits /v2/ → 401 + WWW-Authenticate: Bearer realm=".../token"
 *   2. Client GETs /token with Basic auth (password = SAM project token) and
 *      the requested scope → proxy issues a short-lived HS256 JWT whose
 *      access list is clamped to the project namespace
 *   3. Client retries /v2/... with Bearer JWT → proxy verifies, enforces the
 *      namespace + action, proxies upstream, rewrites Location headers
 */
import { Hono } from 'hono';
import { signRegistryToken, verifyRegistryToken, type RegistryAccess } from './jwt';
import { parseScope, parseV2Path, projectNamespace, requiredAction } from './scope';
import { proxyToUpstream } from './upstream';

export interface Env {
  UPSTREAM_REGISTRY_URL: string;
  REGISTRY_SERVICE: string;
  TOKEN_TTL_SECONDS: string;
  TOKEN_SIGNING_SECRET: string;
  /** SPIKE ONLY: JSON map of { samToken: projectId }. Production validates against the SAM API. */
  DEV_PROJECT_TOKENS?: string;
  UPSTREAM_USERNAME?: string;
  UPSTREAM_PASSWORD?: string;
}

/** Issuer claim baked into every token; verified again on the data path. */
const TOKEN_ISSUER = 'sam-registry-proxy';

/** TTL bounds: never issue a non-positive TTL, and cap at 1 hour. */
const DEFAULT_TOKEN_TTL_SECONDS = 1800;
const MAX_TOKEN_TTL_SECONDS = 3600;

const app = new Hono<{ Bindings: Env }>();

function unauthorized(c: { req: { url: string } }, env: Env): Response {
  const origin = new URL(c.req.url).origin;
  return new Response(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'Docker-Distribution-Api-Version': 'registry/2.0',
      'WWW-Authenticate': `Bearer realm="${origin}/token",service="${env.REGISTRY_SERVICE}"`,
    },
  });
}

function denied(message: string): Response {
  return new Response(JSON.stringify({ errors: [{ code: 'DENIED', message }] }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * SPIKE token validation: look the SAM token up in a static env map.
 * Production: validate against the SAM API / D1 and check the environment's
 * "agents may deploy here" gate before granting push.
 */
function resolveProjectId(samToken: string, env: Env): string | null {
  if (!env.DEV_PROJECT_TOKENS) {
    return null;
  }
  try {
    const map = JSON.parse(env.DEV_PROJECT_TOKENS) as Record<string, string>;
    const projectId = map[samToken];
    // Normalize once at issuance so claims.sub and the repository namespace
    // can never disagree on case.
    return projectId ? projectId.toLowerCase() : null;
  } catch (err) {
    console.error('registry-proxy: DEV_PROJECT_TOKENS is not valid JSON', err);
    return null;
  }
}

/** Registry token-auth endpoint (docker distribution token spec). */
app.get('/token', async (c) => {
  const env = c.env;
  const auth = c.req.header('Authorization') || '';
  if (!auth.startsWith('Basic ')) {
    return unauthorized(c, env);
  }
  let samToken: string;
  try {
    const decoded = atob(auth.slice('Basic '.length));
    const colon = decoded.indexOf(':');
    if (colon === -1) {
      // Malformed Basic credentials (no user:password separator) — reject
      // explicitly rather than treating the whole string as a token.
      return unauthorized(c, env);
    }
    samToken = decoded.slice(colon + 1);
  } catch {
    return unauthorized(c, env);
  }
  const projectId = resolveProjectId(samToken, env);
  if (!projectId) {
    return unauthorized(c, env);
  }

  const namespace = projectNamespace(projectId);
  // A client may request multiple scope params. Grant the intersection of the
  // requested actions and what the project namespace allows; out-of-namespace
  // repositories get an empty action list (standard registry behavior).
  const scopes = new URL(c.req.url).searchParams.getAll('scope');
  const access: RegistryAccess[] = [];
  for (const raw of scopes) {
    const scope = parseScope(raw);
    if (!scope || scope.type !== 'repository') {
      continue;
    }
    const inNamespace = scope.name.startsWith(namespace);
    access.push({
      type: 'repository',
      name: scope.name,
      actions: inNamespace ? scope.actions.filter((a) => a === 'pull' || a === 'push') : [],
    });
  }

  const parsedTtl = Number.parseInt(env.TOKEN_TTL_SECONDS, 10);
  const ttl = Number.isFinite(parsedTtl) && parsedTtl > 0
    ? Math.min(parsedTtl, MAX_TOKEN_TTL_SECONDS)
    : DEFAULT_TOKEN_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  const token = await signRegistryToken(
    {
      sub: projectId,
      iss: TOKEN_ISSUER,
      aud: env.REGISTRY_SERVICE,
      iat: now,
      exp: now + ttl,
      access,
    },
    env.TOKEN_SIGNING_SECRET
  );
  return c.json({ token, access_token: token, expires_in: ttl, issued_at: new Date(now * 1000).toISOString() });
});

/** Everything under /v2/ is the registry data path. */
app.all('/v2/*', async (c) => {
  const env = c.env;
  const auth = c.req.header('Authorization') || '';
  const claims = auth.startsWith('Bearer ')
    ? await verifyRegistryToken(auth.slice('Bearer '.length), env.TOKEN_SIGNING_SECRET, {
        issuer: TOKEN_ISSUER,
        audience: env.REGISTRY_SERVICE,
      })
    : null;
  if (!claims) {
    return unauthorized(c, env);
  }

  const parsed = parseV2Path(new URL(c.req.url).pathname);
  if (parsed.kind === 'ping') {
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Docker-Distribution-Api-Version': 'registry/2.0' },
    });
  }
  if (parsed.kind === 'catalog' || parsed.kind === 'unknown') {
    return denied('this endpoint is not exposed by the SAM registry proxy');
  }

  // Defense in depth: enforce the namespace from the verified claims on every
  // request, independent of what the token's access list says.
  const namespace = projectNamespace(claims.sub);
  if (!parsed.repository.startsWith(namespace)) {
    return denied(`repository must be under ${namespace}`);
  }
  const action = requiredAction(c.req.method);
  const grant = claims.access.find((a) => a.type === 'repository' && a.name === parsed.repository);
  if (!grant || !grant.actions.includes(action)) {
    return denied(`token does not grant '${action}' on ${parsed.repository}`);
  }

  return proxyToUpstream(c.req.raw, {
    upstreamUrl: env.UPSTREAM_REGISTRY_URL,
    username: env.UPSTREAM_USERNAME,
    password: env.UPSTREAM_PASSWORD,
  });
});

// Same-path ping without trailing segment (docker probes GET /v2/).
app.get('/v2', (c) => unauthorized(c, c.env));

app.get('/healthz', (c) => c.json({ ok: true }));

export default app;
