/**
 * The self-host box's Caddy access log (deploy/selfhost/caddy/log-redaction.caddy) replaces a
 * credential that a route carries in its path. This scans the API routes for path parameters named
 * like a credential, so a new one fails here until the redaction filter and this list cover it.
 *
 * It lives with the API unit tests, not with the self-host packaging tests, so that it runs when a
 * route changes. The web app's routes have the same guard in
 * apps/web/tests/unit/selfhost-log-redaction-routes.test.ts (the web suite runs on App.tsx
 * changes). The redaction itself is proven against the real Caddy image in
 * scripts/selfhost/live/access-log-keep-warm.live.test.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../../../../..');
const ROUTES_DIR = resolve(import.meta.dirname, '../../../src/routes');
const REDACTION = resolve(
  import.meta.dirname,
  '../../../../../deploy/selfhost/caddy/log-redaction.caddy'
);

/** Route-definition strings with a path parameter named like a credential. */
const CREDENTIAL_ROUTE =
  /(?:\.(?:get|post|put|patch|delete|all|on)\(|path=)\s*['"`]([^'"`]*\/:(?:[a-z]*token|sig|signature|secret|key|code|jwt|nonce)\b[^'"`]*)['"`]/gi;

/** Each known credential route and the logged path prefix the redaction filter rewrites. */
const KNOWN_CREDENTIAL_ROUTES: Record<string, string> = {
  'apps/api/src/routes/ai-proxy-passthrough.ts /:wstoken/anthropic/v1/messages': '/ai/proxy/',
  'apps/api/src/routes/ai-proxy-passthrough.ts /:wstoken/anthropic/v1/messages/count_tokens':
    '/ai/proxy/',
  'apps/api/src/routes/ai-proxy-passthrough.ts /:wstoken/openai/v1/chat/completions': '/ai/proxy/',
  'apps/api/src/routes/bootstrap.ts /:token': '/api/bootstrap/',
  'apps/api/src/routes/projects/members.ts /invite-links/:token': '/api/projects/invite-links/',
  'apps/api/src/routes/projects/members.ts /invite-links/:token/request':
    '/api/projects/invite-links/',
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/** The path prefixes the filter's `regexp "^(<a>|<b>|...)[^/?]*"` rule rewrites. */
function redactedPrefixes(): string[] {
  const rule = /regexp "\^\(([^)"]+)\)\[\^\/\?\]\*" "\$\{1\}<redacted>"/.exec(
    readFileSync(REDACTION, 'utf8')
  );
  return rule?.[1]?.split('|') ?? [];
}

describe('self-host access log: path credentials', () => {
  it('every route with a credential in its path is on the redaction list', () => {
    const found = routeFiles(ROUTES_DIR)
      .flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(CREDENTIAL_ROUTE)].map(
          (m) => `${relative(REPO, file)} ${m[1]}`
        )
      )
      .sort();
    expect(found.length).toBeGreaterThanOrEqual(6); // the scan itself works
    expect(found).toEqual(Object.keys(KNOWN_CREDENTIAL_ROUTES).sort());
  });

  it('log-redaction.caddy rewrites the prefix each of those routes is served under', () => {
    const prefixes = redactedPrefixes();
    expect(prefixes.length).toBeGreaterThan(0); // the rule was found
    for (const prefix of Object.values(KNOWN_CREDENTIAL_ROUTES)) {
      expect(prefixes).toContain(prefix);
    }
  });
});
