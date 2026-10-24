/**
 * URLs for the project Automation page, and the mapping from the Events and Triggers URLs
 * it replaced. Every link into Automation goes through these builders so a route change
 * cannot leave a stale link behind.
 *
 * The old URLs stay reachable because other surfaces still emit them: the API builds
 * `/projects/:id/triggers/:triggerId` hrefs (`credential-attribution-health.ts`,
 * `project-offboarding-preview-resources.ts`), and people have bookmarks.
 */

/** The three stored kinds of automation, as they appear in URLs. */
export const AUTOMATION_KINDS = ['trigger', 'schedule', 'watch'] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

export function isAutomationKind(value: string | undefined): value is AutomationKind {
  return AUTOMATION_KINDS.includes(value as AutomationKind);
}

/** What starts a new automation; chosen on the first step of the create flow. */
export const AUTOMATION_STARTS = [
  'schedule',
  'once',
  'github',
  'webhook',
  'email',
  'event',
] as const;
export type AutomationStart = (typeof AUTOMATION_STARTS)[number];

export function isAutomationStart(value: string | null | undefined): value is AutomationStart {
  return AUTOMATION_STARTS.includes(value as AutomationStart);
}

export type BehindTab = 'waiting' | 'channels';

/** Workflows list filters; `all` is the default and stays out of the URL. */
export const WORKFLOW_FILTERS = ['all', 'active', 'needs_attention', 'completed'] as const;
export type WorkflowFilter = (typeof WORKFLOW_FILTERS)[number];

export function isWorkflowFilter(value: string | null | undefined): value is WorkflowFilter {
  return WORKFLOW_FILTERS.includes(value as WorkflowFilter);
}

/** The run page's views. The default (no `view`) depends on the screen size. */
export const WORKFLOW_RUN_VIEWS = ['steps', 'graph', 'activity'] as const;
export type WorkflowRunView = (typeof WORKFLOW_RUN_VIEWS)[number];

export function isWorkflowRunView(value: string | null | undefined): value is WorkflowRunView {
  return WORKFLOW_RUN_VIEWS.includes(value as WorkflowRunView);
}

/**
 * A chat in the project: the chats that automations start, message or run as workflow steps.
 *
 * Re-exported from `project-routes.ts`, which is where it lives now that linked work links to
 * chats too. Automation's own importers keep this path.
 */
export { projectChatPath } from './project-routes';

/** Overview list filters; also the target of old `?section=` links. */
export const OVERVIEW_FILTERS = ['all', 'scheduled', 'reacting', 'once', 'stopped'] as const;
export type OverviewFilter = (typeof OVERVIEW_FILTERS)[number];

export function isOverviewFilter(value: string | null | undefined): value is OverviewFilter {
  return OVERVIEW_FILTERS.includes(value as OverviewFilter);
}

const root = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/automation`;

function withQuery(path: string, params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export const automationPaths = {
  overview: (projectId: string, filter?: OverviewFilter) =>
    withQuery(root(projectId), { filter: filter === 'all' ? undefined : filter }),
  /**
   * The create flow. `start` or `template` opens it at step two; `sessionId` makes "message this
   * chat" the default action, which is how the chat panel's "Remind this chat later" opens it.
   */
  create: (
    projectId: string,
    options: { start?: AutomationStart; sessionId?: string; template?: string } = {}
  ) =>
    withQuery(`${root(projectId)}/new`, {
      start: options.start,
      sessionId: options.sessionId,
      template: options.template,
    }),
  detail: (projectId: string, kind: AutomationKind, id: string) =>
    `${root(projectId)}/${kind}/${encodeURIComponent(id)}`,
  edit: (projectId: string, kind: AutomationKind, id: string) =>
    `${root(projectId)}/${kind}/${encodeURIComponent(id)}/edit`,
  history: (projectId: string, item?: { kind: AutomationKind; id: string }) =>
    withQuery(`${root(projectId)}/history`, { item: item ? `${item.kind}:${item.id}` : undefined }),
  behind: (projectId: string, options: { tab?: BehindTab; sessionId?: string } = {}) =>
    withQuery(`${root(projectId)}/behind`, {
      tab: options.tab === 'channels' ? 'channels' : undefined,
      sessionId: options.sessionId,
    }),
  /** Every workflow run in the project, optionally one status. */
  workflows: (projectId: string, filter?: WorkflowFilter) =>
    withQuery(`${root(projectId)}/workflows`, {
      status: filter === 'all' ? undefined : filter,
    }),
  /** One run; `step` selects a step, `view` picks Steps, Graph or Activity. */
  workflow: (
    projectId: string,
    runId: string,
    options: { step?: string; view?: WorkflowRunView } = {}
  ) =>
    withQuery(`${root(projectId)}/workflows/${encodeURIComponent(runId)}`, {
      view: options.view,
      step: options.step,
    }),
};

/** `kind:id` from a History `?item=` value, or null when it is malformed. */
export function parseHistoryItem(
  value: string | null
): { kind: AutomationKind; id: string } | null {
  if (!value) return null;
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return isAutomationKind(kind) && id ? { kind, id } : null;
}

/**
 * Where an old `/projects/:id/events?…` URL lands. The Events page had four sections; two of
 * them (schedules, standing watches) are now part of the Automation list itself, and the other
 * two (subscriptions, channels) live under "Behind the scenes".
 */
export function legacyEventsTarget(projectId: string, search: URLSearchParams): string {
  const section = search.get('section');
  const sessionId = search.get('sessionId') || undefined;
  if (section === 'channels') return automationPaths.behind(projectId, { tab: 'channels' });
  // A chat-scoped link came from the chat's Events drawer. Its replacement, the chat-scoped view,
  // shows what that chat waits for and every schedule and watch that messages it.
  if (sessionId) return automationPaths.behind(projectId, { sessionId });
  if (section === 'schedules') return automationPaths.overview(projectId, 'once');
  if (section === 'watches') return automationPaths.overview(projectId, 'reacting');
  if (section === 'subscriptions') return automationPaths.behind(projectId);
  return automationPaths.overview(projectId);
}

/** Where an old `/projects/:id/triggers?edit=…` URL lands. */
export function legacyTriggersTarget(projectId: string, search: URLSearchParams): string {
  const edit = search.get('edit');
  if (edit === 'new') return automationPaths.create(projectId);
  if (edit) return automationPaths.edit(projectId, 'trigger', edit);
  return automationPaths.overview(projectId);
}
