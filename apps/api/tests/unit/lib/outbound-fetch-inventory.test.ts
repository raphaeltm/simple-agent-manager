/**
 * Machine-checked inventory of outbound requests (self-host T5, rule 61).
 *
 * Every file under src/ that calls the global `fetch(` or the `fetchWithTimeout(` helper must
 * either go through the shared guard (`lib/network-hosts`: guardedFetch / assertOutboundUrl, or
 * `fetchChatTarget`) or be listed here with the reason its URL cannot be chosen by a user,
 * project member or node. A new call site fails this test until someone makes that decision.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../../../src');

const CONSTANT = 'fixed provider host (constant URL); path/query from platform data only';
const OPERATOR = 'operator-configured env var, not user-settable';
const PLATFORM_NODE =
  'platform-built node URL (node row, or 127.0.0.1:{lease} on self-host); redirect: manual on every transport (nodeAgentRequestInit)';

/** Files whose outbound URLs no user, member or node chooses, with the reason. */
const NOT_USER_CONTROLLED: Record<string, string> = {
  'auth.ts': `GitHub user/emails API: ${CONSTANT}`,
  'durable-objects/codex-refresh-lock.ts': `Codex OAuth refresh: ${OPERATOR} (CODEX_REFRESH_UPSTREAM_URL)`,
  'durable-objects/sam-session/tools/get-ci-status.ts': `api.github.com: ${CONSTANT}`,
  'durable-objects/sam-session/tools/get-file-content.ts': `api.github.com: ${CONSTANT}`,
  'durable-objects/sam-session/tools/search-code.ts': `api.github.com: ${CONSTANT}`,
  'index.ts': `Pages proxy: ${OPERATOR} (PAGES_PROJECT_NAME)`,
  'lib/network-hosts/guarded-fetch.ts': 'the guard itself',
  'operations/pull-request-core.ts': `api.github.com: ${CONSTANT}`,
  'routes/admin-analytics-query.ts': `Cloudflare Analytics API: ${OPERATOR}, superadmin route`,
  'routes/ai-proxy-anthropic.ts': `Anthropic / AI Gateway: ${CONSTANT}`,
  'routes/google-auth.ts': `Google OAuth: ${CONSTANT}`,
  'routes/project-deployment.ts': `Google token endpoint: ${CONSTANT}`,
  'routes/projects/devcontainer-configs.ts': `api.github.com: ${CONSTANT}`,
  'routes/workspace-subdomain-proxy.ts': PLATFORM_NODE,
  'services/agent-credential-validation.ts': `provider key validation: ${CONSTANT}`,
  'services/agent-email/cloudflare-email-api.ts': `Cloudflare API: ${CONSTANT}`,
  'services/agent-email/setup-spf-lookups.ts': `DoH resolver: ${OPERATOR} (DOH_RESOLVER_URL); user domain only as a query parameter`,
  'services/agent-models/workers-ai.ts': `Cloudflare API: ${CONSTANT}`,
  'services/ai-gateway-logs.ts': `Cloudflare API: ${CONSTANT}`,
  'services/analytics-forward.ts': `Segment/GA4: ${OPERATOR}, prefix allowlist (assertAllowedUrl)`,
  'services/cf-registry.ts': `Cloudflare API: ${CONSTANT}`,
  'services/cloudflare-tunnel-api.ts': `Cloudflare API: ${CONSTANT}`,
  'services/deployment-domain-verify.ts': `DoH resolver: ${OPERATOR}; user domain only as a query parameter`,
  'services/dns-app-routes.ts': `Cloudflare DNS API: ${CONSTANT}`,
  'services/dns-core.ts': `Cloudflare DNS API: ${CONSTANT}`,
  'services/dns-node-backend.ts': `Cloudflare DNS API: ${CONSTANT}`,
  'services/dns-workspace.ts': `Cloudflare DNS API: ${CONSTANT}`,
  'services/fetch-timeout.ts': 'the timeout helper; its callers are checked here individually',
  'services/gcp-fetch.ts': `Google Cloud APIs helper: ${CONSTANT}`,
  'services/gcp-service-account.ts': `Google IAM: ${CONSTANT}`,
  'services/gcp-setup-transport.ts': `Google Cloud APIs helper: ${CONSTANT}`,
  'services/gcp-setup.ts': `Google Cloud APIs: ${CONSTANT}`,
  'services/gcp-sts.ts': `Google STS: ${CONSTANT}`,
  'services/github-app-branches.ts': `api.github.com: ${CONSTANT}`,
  'services/github-app-installation.ts': `api.github.com: ${CONSTANT}`,
  'services/github-app-repositories.ts': `api.github.com: ${CONSTANT}`,
  'services/github-app-tokens.ts': `api.github.com: ${CONSTANT}`,
  'services/github-app-user.ts': `api.github.com: ${CONSTANT}`,
  'services/github-oauth-refresh.ts': `github.com OAuth: ${CONSTANT}`,
  'services/github-pull-request-branch.ts': `api.github.com: ${CONSTANT}`,
  'services/model-catalog.ts': `model catalog: ${OPERATOR} (MODEL_CATALOG_SOURCE_URL)`,
  'services/node-agent.ts': PLATFORM_NODE,
  'services/observability-logs.ts': `Cloudflare API: ${CONSTANT}`,
  'services/platform-config-validation.ts': `GitHub token endpoint: ${CONSTANT}`,
  'services/repo-browse/github.ts': `api.github.com: ${CONSTANT}`,
  'services/task-runtime-liveness-node-probe.ts': PLATFORM_NODE,
  'services/validation.ts': `cloud provider credential checks: ${CONSTANT}`,
};

const GUARD = /from '[./]*lib\/network-hosts'|from '\.\/network-hosts'|\bfetchChatTarget\b/;
const CALL = /(?<![.\w$])(fetch|fetchWithTimeout)\(/;
const DEFINITION = /\basync\s+(fetch|fetchWithTimeout)\(|function\s+(fetch|fetchWithTimeout)\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Files with a real call (not a comment, not a method or function definition). */
function filesWithOutboundCalls(): string[] {
  return sourceFiles(SRC).filter((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .some((line) => {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return false;
        return CALL.test(code) && !DEFINITION.test(code);
      })
  );
}

describe('outbound fetch inventory', () => {
  const files = filesWithOutboundCalls().map((path) => relative(SRC, path));

  it('finds the call sites (a broken scan must not pass as "all clear")', () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
  });

  it('every call site is guarded or listed with a reason', () => {
    const unguarded = files.filter((file) => {
      if (file in NOT_USER_CONTROLLED) return false;
      return !GUARD.test(readFileSync(join(SRC, file), 'utf8'));
    });
    expect(unguarded).toEqual([]);
  });

  it('the list has no stale entries', () => {
    const stale = Object.keys(NOT_USER_CONTROLLED).filter((file) => !files.includes(file));
    expect(stale).toEqual([]);
  });

  it('the user- and admin-chosen URL sites use the guard', () => {
    for (const file of [
      'routes/ai-proxy-passthrough-prepare.ts',
      'services/llm-chat-target.ts',
      'services/gitlab.ts',
    ]) {
      expect(readFileSync(join(SRC, file), 'utf8')).toMatch(GUARD);
    }
  });
});
