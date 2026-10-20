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
export const AUTOMATION_STARTS = ['schedule', 'once', 'github', 'webhook', 'event'] as const;
export type AutomationStart = (typeof AUTOMATION_STARTS)[number];

export function isAutomationStart(value: string | null | undefined): value is AutomationStart {
  return AUTOMATION_STARTS.includes(value as AutomationStart);
}

export type BehindTab = 'waiting' | 'channels';

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
   * The create flow. `start` skips the first step; `sessionId` makes "message this chat" the
   * default action, which is how the chat panel's "Remind this chat later" opens it.
   */
  create: (projectId: string, options: { start?: AutomationStart; sessionId?: string } = {}) =>
    withQuery(`${root(projectId)}/new`, { start: options.start, sessionId: options.sessionId }),
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
};

/** `kind:id` from a History `?item=` value, or null when it is malformed. */
export function parseHistoryItem(value: string | null): { kind: AutomationKind; id: string } | null {
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
  if (section === 'schedules') return automationPaths.overview(projectId, 'once');
  if (section === 'watches') return automationPaths.overview(projectId, 'reacting');
  // A session-scoped Events link came from the chat's Events drawer, whose first tab listed
  // what that chat was waiting for.
  if (section === 'subscriptions' || sessionId)
    return automationPaths.behind(projectId, { sessionId });
  return automationPaths.overview(projectId);
}

/** Where an old `/projects/:id/triggers?edit=…` URL lands. */
export function legacyTriggersTarget(projectId: string, search: URLSearchParams): string {
  const edit = search.get('edit');
  if (edit === 'new') return automationPaths.create(projectId);
  if (edit) return automationPaths.edit(projectId, 'trigger', edit);
  return automationPaths.overview(projectId);
}
