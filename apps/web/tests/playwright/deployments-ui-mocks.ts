/**
 * The API mock for the Deployments pages: every route the list and environment pages read,
 * answered from `deployments-ui-fixtures.ts`. Shared by `deployments-ui-audit.spec.ts` and
 * the docs capture spec so the two cannot drift.
 *
 * The mock matches on the URL path, not a `**\/api/**` glob: in dev mode that glob also
 * catches the app's own `/src/lib/api/*.ts` modules.
 */
import type { Page, Route } from '@playwright/test';

import { seedTheme } from './audit-helpers';
import {
  CONFIG,
  CONTAINERS,
  CUSTOM_DOMAINS,
  ENVIRONMENTS,
  LOGS,
  MOCK_PROJECT,
  MOCK_USER,
  PROFILES,
  PROJECT_ID,
  PUBLIC_ROUTES,
  RELEASE_EVENTS,
  RELEASES,
  SYSTEM_INFO,
  TASK_TITLES,
  USER_ID,
  VOLUMES,
  withRoutedHostnames,
} from './deployments-ui-fixtures';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

export interface MockOptions {
  environments?: unknown[];
  /** Path suffixes (after `/environments/:id`) that answer 500, or 'list' for the list itself. */
  failing?: string[];
  /** Path suffixes that wait for `until` before answering: the page while data is in flight. */
  hold?: { paths: string[]; until: Promise<void> };
}

export interface PolicyWrite {
  envId: string;
  body: Record<string, unknown>;
}

export async function mockApi(page: Page, opts: MockOptions = {}): Promise<PolicyWrite[]> {
  const environments = opts.environments ?? ENVIRONMENTS;
  const failing = new Set(opts.failing ?? []);
  const policyWrites: PolicyWrite[] = [];
  await seedTheme(page, 'dark');
  await page.addInitScript((uid) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${uid}`, 'true');
  }, USER_ID);
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const method = route.request().method();
      const envMatch = path.match(/^\/api\/projects\/[^/]+\/environments\/([^/]+)(\/.*)?$/);

      if (path === '/api/auth/get-session') return json(route, MOCK_USER);
      if (path === '/api/github/installations') return json(route, []);
      if (path === '/api/projects') return json(route, { projects: [MOCK_PROJECT], total: 1 });
      if (path === '/api/agents') return json(route, { agents: [] });
      if (path === '/api/credentials') return json(route, []);
      if (path === '/api/credentials/agent') return json(route, { credentials: [] });
      if (path === '/api/notifications')
        return json(route, { notifications: [], unreadCount: 0, nextCursor: null });
      if (path === '/api/trial/status') return json(route, { available: false });
      if (path === '/api/providers/catalog') return json(route, { catalogs: [] });
      if (path === `/api/projects/${PROJECT_ID}`) return json(route, MOCK_PROJECT);
      if (path === `/api/projects/${PROJECT_ID}/agent-profiles`)
        return json(route, { items: PROFILES });
      const task = path.match(/^\/api\/projects\/[^/]+\/tasks\/([^/]+)$/);
      if (task) {
        const id = task[1] ?? '';
        return json(route, {
          id,
          projectId: PROJECT_ID,
          title: TASK_TITLES[id] ?? 'A chat',
          status: 'completed',
        });
      }
      if (path === `/api/projects/${PROJECT_ID}/environments`) {
        if (failing.has('list'))
          return json(route, { error: 'INTERNAL_ERROR', message: 'D1 is unavailable' }, 500);
        if (method === 'POST')
          return json(route, { ...ENVIRONMENTS[6], id: 'env-new', name: 'staging-eu' });
        return json(route, { environments: withRoutedHostnames(environments) });
      }
      if (envMatch) {
        const envId = envMatch[1] ?? '';
        const rest = envMatch[2] ?? '';
        const env = environments.find((item) => (item as { id: string }).id === envId);
        if (failing.has(rest))
          return json(route, { error: 'INTERNAL_ERROR', message: 'Upstream read failed' }, 500);
        if (opts.hold?.paths.includes(rest)) await opts.hold.until;
        if (rest === '/policy' && method === 'PATCH') {
          policyWrites.push({
            envId,
            body: route.request().postDataJSON() as Record<string, unknown>,
          });
          return json(route, env ?? {});
        }
        if (rest === '/releases') return json(route, { releases: RELEASES[envId] ?? [] });
        const events = rest.match(/^\/releases\/([^/]+)\/events$/);
        if (events) return json(route, { events: RELEASE_EVENTS[events[1] ?? ''] ?? [] });
        if (rest === '/runtime-config')
          return json(
            route,
            CONFIG[envId] ?? { envVars: [], updatedAt: null, variableCount: 0, secretCount: 0 }
          );
        if (rest === '/public-routes')
          return json(route, { publicRoutes: PUBLIC_ROUTES[envId] ?? [] });
        if (rest === '/custom-domains')
          return json(route, { customDomains: CUSTOM_DOMAINS[envId] ?? [] });
        if (rest === '/volumes') return json(route, { volumes: VOLUMES[envId] ?? [] });
        if (rest === '/containers') return json(route, CONTAINERS);
        if (rest === '/metrics')
          return json(route, {
            systemInfo: SYSTEM_INFO,
            nodeId: 'node-prod',
            fallbackMetrics: null,
          });
        if (rest === '/logs') {
          if (envId === 'env-eu')
            return json(route, {
              entries: [],
              nextCursor: null,
              unavailableReason: 'node_agent_unreachable',
            });
          if (envId === 'env-docs' || envId === 'env-load')
            return json(route, {
              entries: [],
              nextCursor: null,
              unavailableReason: 'node_not_running',
            });
          const level = url.searchParams.get('level');
          const entries = (LOGS[envId] ?? []) as Array<{ level: string }>;
          return json(route, {
            entries: level ? entries.filter((entry) => entry.level === level) : entries,
            nextCursor: null,
          });
        }
        return json(route, env ?? {});
      }
      return json(route, {});
    }
  );
  return policyWrites;
}
