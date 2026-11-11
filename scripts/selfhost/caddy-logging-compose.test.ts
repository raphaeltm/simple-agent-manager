/**
 * Static wiring for Caddy's access log and the keep-warm health check (the behaviour itself is
 * proven against the real Caddy image in live/access-log-keep-warm.live.test.ts): compose passes
 * the keep-warm settings with their defaults and caps the Caddy log on disk, and both Caddy
 * loggers import the one redaction filter.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO = resolve(import.meta.dirname, '../..');
const SELFHOST = resolve(REPO, 'deploy/selfhost');

interface Service {
  environment?: Record<string, string>;
  logging?: { driver?: string; options?: Record<string, string> };
}

const compose = parse(readFileSync(`${SELFHOST}/docker-compose.yml`, 'utf8')) as {
  services: Record<string, Service>;
};
const caddy = compose.services.caddy;
const caddyfile = readFileSync(`${SELFHOST}/caddy/Caddyfile`, 'utf8');
const redaction = readFileSync(`${SELFHOST}/caddy/log-redaction.caddy`, 'utf8');
const keepWarm = readFileSync(`${SELFHOST}/caddy/keep-warm/on.caddy`, 'utf8');

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
  'apps/web/src/App.tsx /projects/invite/:token': '/projects/invite/',
};

const PATH_CREDENTIAL_PREFIXES = [
  '/ai/proxy/',
  '/api/bootstrap/',
  '/api/projects/invite-links/',
  '/projects/invite/',
];

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('Caddy logging and keep-warm wiring', () => {
  it('passes keep-warm on by default, at 5 s', () => {
    expect(caddy?.environment?.SAM_KEEP_WARM).toBe('${SAM_KEEP_WARM:-on}');
    expect(caddy?.environment?.SAM_KEEP_WARM_INTERVAL).toBe('${SAM_KEEP_WARM_INTERVAL:-5s}');
  });

  it('caps the Caddy log on disk', () => {
    expect(caddy?.logging?.driver).toBe('json-file');
    expect(caddy?.logging?.options?.['max-size']).toBe('${CADDY_LOG_MAX_SIZE:-50m}');
    expect(caddy?.logging?.options?.['max-file']).toBe('${CADDY_LOG_MAX_FILES:-5}');
  });

  it('applies the one redaction filter to the access log and to Caddy own log', () => {
    expect(caddyfile.match(/import log-redaction\.caddy/g)).toHaveLength(2);
    expect(caddyfile).toMatch(/log default \{\s*output stderr\s*import log-redaction\.caddy/);
    expect(caddyfile).toMatch(/\tlog \{\s*output stdout\s*import log-redaction\.caddy/);
  });

  it('the redaction filter drops headers, query strings and path credentials', () => {
    expect(redaction).toMatch(/^\trequest>headers delete$/m);
    expect(redaction).toMatch(/^\tresp_headers delete$/m);
    expect(redaction).toMatch(/^\theaders delete$/m);
    expect(redaction).toContain('\t\tregexp "\\?.*$" "?<redacted>"');
    expect(redaction).toContain('\t\tregexp "^/p/[^?]*" "/p/<redacted>"');
    for (const prefix of PATH_CREDENTIAL_PREFIXES) {
      expect(redaction).toMatch(new RegExp(`regexp "\\^\\([^"]*\\|?${prefix}\\|?[^"]*\\)`));
    }
  });

  // Every route whose path carries a credential-like parameter must be redacted in the logs.
  // A new one fails here until it is added to caddy/log-redaction.caddy and to this list.
  it('every route with a credential in its path is on the redaction list', () => {
    const found = [
      ...routeFiles(join(REPO, 'apps/api/src/routes')),
      join(REPO, 'apps/web/src/App.tsx'),
    ]
      .flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(CREDENTIAL_ROUTE)].map(
          (m) => `${relative(REPO, file)} ${m[1]}`
        )
      )
      .sort();
    expect(found.length).toBeGreaterThanOrEqual(6); // the scan itself works
    expect(found).toEqual(Object.keys(KNOWN_CREDENTIAL_ROUTES).sort());
    for (const prefix of Object.values(KNOWN_CREDENTIAL_ROUTES)) {
      expect(PATH_CREDENTIAL_PREFIXES).toContain(prefix);
    }
  });

  it('keeps the keep-warm check on a route that never serves a request', () => {
    expect(caddyfile).toContain('import keep-warm/{$SAM_KEEP_WARM:on}.caddy');
    expect(keepWarm).toMatch(/^@sam_keep_warm expression false$/m);
    expect(keepWarm).toContain('handle @sam_keep_warm {');
    expect(keepWarm).toContain('health_uri /health');
    expect(keepWarm).toContain('health_interval {$SAM_KEEP_WARM_INTERVAL:5s}');
  });
});
