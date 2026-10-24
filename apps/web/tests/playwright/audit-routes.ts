/**
 * Route mocking for the Playwright audits.
 *
 * Split out of `audit-helpers.ts` when that file crossed 800 lines
 * (`.claude/rules/18-file-size-limits.md`). `audit-helpers.ts` re-exports everything here, so
 * no spec had to change its imports.
 */
import type { Page, Route } from '@playwright/test';

export type AuditResponder = (status: number, body: unknown) => Promise<void>;

/**
 * The whole mock preamble a project-scoped page audit needs: dismiss the first-run wizard,
 * register the catch-all route, answer the app shell, then hand the spec the `/api/projects/:id`
 * sub-path it actually cares about.
 *
 * `onProjectSubPath` receives `''` for the project itself and `/ideas/x` style suffixes
 * otherwise, and returns `undefined` for anything it does not handle, which falls through to an
 * empty 200 so an unmocked endpoint never hangs the page.
 *
 * Shared because the ideas audits had the same twelve-line preamble each, which is both a
 * maintenance trap and what SonarCloud counts as duplication.
 */
export async function setupProjectAuditRoutes(
  page: Page,
  options: {
    user: { user: { id: string } };
    project: unknown;
    commonSubPaths?: Record<string, unknown>;
    onProjectSubPath: (
      sub: string,
      respond: AuditResponder,
      route: Route
    ) => Promise<void> | undefined;
  }
) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, options.user.user.id);

  await setupAuditRoutes(page, (path, respond, route) => {
    const shell = respondToAppShellRoute(path, respond, {
      user: options.user,
      projects: [options.project],
    });
    if (shell) return shell;

    const match = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!match) return undefined;
    const sub = match[2] ?? '';
    if (sub === '') return respond(200, options.project);
    return options.onProjectSubPath(sub, respond, route);
  });
}

/**
 * The app-shell endpoints every audited page loads before its own data.
 *
 * Auth, the project list, agents, active tasks, notifications, GitHub, credentials and nodes
 * are loaded by the shell around whatever page is under test, so each spec was re-declaring
 * the same handler chain. Returns `undefined` for anything it does not handle, so a spec can
 * call it first and then match its own routes:
 *
 * ```ts
 * await setupAuditRoutes(page, (path, respond) => {
 *   const shell = respondToAppShellRoute(path, respond, { user, projects });
 *   if (shell) return shell;
 *   // ...the spec's own routes
 * });
 * ```
 */
export function respondToAppShellRoute(
  path: string,
  respond: AuditResponder,
  options: { user: unknown; projects?: unknown[] }
): Promise<void> | undefined {
  if (path.startsWith('/api/auth/')) return respond(200, options.user);
  if (path === '/api/projects') return respond(200, { projects: options.projects ?? [] });
  if (path === '/api/agents') return respond(200, { agents: [] });
  if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
  if (path.startsWith('/api/notifications')) {
    return respond(200, { notifications: [], unreadCount: 0 });
  }
  if (path.startsWith('/api/github')) return respond(200, []);
  if (path === '/api/credentials') return respond(200, []);
  if (path.startsWith('/api/credentials/')) return respond(200, { consumers: [], credentials: [] });
  if (path.startsWith('/api/nodes')) return respond(200, { nodes: [] });
  return undefined;
}

/**
 * Registers the catch-all `/api` glob route used by the theme audits. The
 * supplied handler returns the `respond(...)` promise for paths it handles and
 * `undefined` for everything else, which falls through to an empty `{}` 200 so
 * unmocked endpoints never hang the page.
 */
export async function setupAuditRoutes(
  page: Page,
  handler: (path: string, respond: AuditResponder, route: Route) => Promise<void> | undefined
) {
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond: AuditResponder = (status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const result = handler(path, respond, route);
    if (result === undefined) return respond(200, {});
    return result;
  });
}

interface ProjectChatMockOptions {
  projectId: string;
  project: unknown;
  session: unknown;
  messages: unknown[];
  user?: { id: string; name: string; email: string };
}

/**
 * Registers the common API route mocks needed to render a project chat session
 * (auth, project, session+messages, and the sidebar/dropdown data the page
 * loads). Specs supply their own session/messages and may register additional
 * routes (e.g. tool-content) after calling this — later-registered Playwright
 * routes take precedence for their specific URLs.
 */
export async function setupProjectChatMocks(page: Page, options: ProjectChatMockOptions) {
  const {
    projectId,
    project,
    session,
    messages,
    user = { id: 'test-user', name: 'Test User', email: 'test@example.com' },
  } = options;

  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, user.id);

  await page.route('**/api/auth/get-session', (route: Route) =>
    route.fulfill({ status: 200, json: { user } })
  );

  await page.route('**/api/github/installations', (route: Route) =>
    route.fulfill({ status: 200, json: [] })
  );

  await page.route(new RegExp(`/api/projects/${projectId}(?:\\?.*)?$`), (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, json: project });
    }
    return route.continue();
  });

  await page.route(
    new RegExp(`/api/projects/${projectId}/sessions/[^/]+(?:\\?.*)?$`),
    (route: Route) => route.fulfill({ status: 200, json: { session, messages, hasMore: false } })
  );

  await page.route(`**/api/projects/${projectId}/sessions*`, (route: Route) =>
    route.fulfill({ status: 200, json: { sessions: [session], total: 1 } })
  );

  await page.route(`**/api/projects/${projectId}/tasks*`, (route: Route) =>
    route.fulfill({ status: 200, json: { tasks: [], total: 0 } })
  );

  await page.route(`**/api/projects/${projectId}/agent-profiles`, (route: Route) =>
    route.fulfill({ status: 200, json: { items: [] } })
  );

  await page.route('**/api/credentials', (route: Route) =>
    route.fulfill({ status: 200, json: [{ provider: 'hetzner', status: 'valid' }] })
  );

  await page.route('**/api/trial/status', (route: Route) =>
    route.fulfill({ status: 200, json: { available: false } })
  );

  await page.route('**/api/agents', (route: Route) =>
    route.fulfill({ status: 200, json: { agents: [] } })
  );

  await page.route(`**/api/projects/${projectId}/commands*`, (route: Route) =>
    route.fulfill({ status: 200, json: { commands: [] } })
  );
}

// ---------------------------------------------------------------------------
// Sleeping / waking project chat mocks
// ---------------------------------------------------------------------------

/** A project row with the fields the project chat route reads. */
