/**
 * The Account Map's "connections" model: projects → chats and tasks → machines.
 *
 * Built from `GET /api/account-map` without any layout engine. A chat and the task it belongs to
 * are one item, so each piece of work appears once. Pure functions only, so the page and its
 * tests share one source of truth for what links to what.
 */
import type { AccountMapResponse } from '../../lib/api';

export type WorkState = 'needs-you' | 'failed' | 'working' | 'idle' | 'asleep' | 'done';
export type MapFilter = 'all' | 'attention' | 'live';

export interface MapProject {
  id: string;
  name: string;
  repository: string | null;
  lastActivityAt: string | null;
}

export interface MapIdea {
  id: string;
  projectId: string;
  title: string;
}

export interface MapWork {
  /** The chat's id when there is a chat, otherwise the task's id. */
  id: string;
  kind: 'chat' | 'task';
  projectId: string;
  title: string;
  state: WorkState;
  sessionId: string | null;
  taskId: string | null;
  workspaceId: string | null;
  ideaIds: string[];
  prUrl: string | null;
  /** What the agent is waiting on, when it is waiting on you. */
  attentionReason: string | null;
}

export interface MapWorkspace {
  id: string;
  projectId: string | null;
  machineId: string;
  label: string;
  status: string;
}

export interface MapMachine {
  id: string;
  /**
   * Not a real node: `instant` collects workspaces with no node (Instant containers, or not
   * placed yet); `unlisted` collects workspaces whose node is not in the response (stopped,
   * past the cap, or deleted).
   */
  placeholder: false | 'instant' | 'unlisted';
  name: string;
  provider: string | null;
  size: string | null;
  location: string | null;
  status: string;
  health: string | null;
  workspaces: MapWorkspace[];
}

export interface MapEdge {
  from: string;
  to: string;
  /** Amber means waiting on you, red means failed: never one colour for both (SAM Glass). */
  tone: 'attention' | 'failed' | 'live' | 'quiet';
}

export interface ConnectionsModel {
  projects: MapProject[];
  work: MapWork[];
  machines: MapMachine[];
  ideas: Map<string, MapIdea>;
}

export interface ConnectionsView {
  projects: MapProject[];
  /** Projects with nothing on the map, hidden unless the user asks for them. */
  quietProjects: MapProject[];
  work: MapWork[];
  machines: MapMachine[];
  edges: MapEdge[];
}

/** Id of the shared entry for workspaces without a machine. */
export const NO_MACHINE_ID = 'account-map:no-machine';
/** Id of the shared entry for workspaces whose machine is not on the map. */
export const UNLISTED_MACHINE_ID = 'account-map:machine-unlisted';

const STATE_ORDER: Record<WorkState, number> = {
  'needs-you': 0,
  failed: 1,
  working: 2,
  idle: 3,
  asleep: 4,
  done: 5,
};

const DONE_TASK_STATUSES = new Set(['completed', 'cancelled']);

type Session = AccountMapResponse['sessions'][number];
type Task = AccountMapResponse['tasks'][number];

function workState(session: Session | undefined, task: Task | undefined): WorkState {
  if (session?.attention) return 'needs-you';
  // A superseded task was replaced by a newer one; its old failure is history, not a problem.
  if (task?.agentActivityState === 'superseded') return 'done';
  if (task?.status === 'failed' || session?.status === 'error') return 'failed';
  if (task && DONE_TASK_STATUSES.has(task.status)) return 'done';
  if (task?.agentActivityState === 'working') return 'working';
  if (task?.agentActivityState === 'sleeping' || session?.status === 'sleeping') return 'asleep';
  if (session?.status === 'stopped') return 'done';
  return 'idle';
}

function placeholderMachine(kind: 'instant' | 'unlisted'): MapMachine {
  return {
    id: kind === 'instant' ? NO_MACHINE_ID : UNLISTED_MACHINE_ID,
    placeholder: kind,
    name: kind === 'instant' ? 'No machine' : 'Machine not listed',
    provider: null,
    size: null,
    location: null,
    status: kind === 'instant' ? 'running' : 'unknown',
    health: null,
    workspaces: [],
  };
}

export function buildConnectionsModel(data: AccountMapResponse): ConnectionsModel {
  const tasksById = new Map(data.tasks.map((t) => [t.id, t]));
  const workspaceIds = new Set(data.workspaces.map((w) => w.id));
  const workspaceByChat = new Map(
    data.workspaces.filter((w) => w.chatSessionId).map((w) => [w.chatSessionId as string, w.id])
  );
  const ideaIdsBySession = new Map<string, string[]>();
  for (const r of data.relationships) {
    if (r.type !== 'idea_session') continue;
    const ids = ideaIdsBySession.get(r.target) ?? [];
    if (!ids.includes(r.source)) ids.push(r.source);
    ideaIdsBySession.set(r.target, ids);
  }
  // The first candidate that is actually on the map; a stale id must not hide a live one.
  const listedWorkspace = (...candidates: Array<string | null | undefined>) =>
    candidates.find((id): id is string => Boolean(id) && workspaceIds.has(id as string)) ?? null;

  const work: MapWork[] = [];
  const tasksWithChat = new Set<string>();
  for (const s of data.sessions) {
    const task = s.taskId ? tasksById.get(s.taskId) : undefined;
    // A task that was retried can own several chats; it is one piece of work, shown once, through
    // its newest chat (sessions arrive newest first).
    if (task && tasksWithChat.has(task.id)) continue;
    if (task) tasksWithChat.add(task.id);
    work.push({
      id: s.id,
      kind: task ? 'task' : 'chat',
      projectId: s.projectId,
      title: task?.title || s.topic || 'Untitled chat',
      state: workState(s, task),
      sessionId: s.id,
      taskId: task?.id ?? s.taskId,
      workspaceId: listedWorkspace(s.workspaceId, task?.workspaceId, workspaceByChat.get(s.id)),
      ideaIds: ideaIdsBySession.get(s.id) ?? [],
      prUrl: task?.outputPrUrl ?? null,
      attentionReason: s.attention ? (s.attention.reason ?? 'Waiting on you') : null,
    });
  }
  for (const t of data.tasks) {
    if (tasksWithChat.has(t.id) || !t.projectId) continue;
    work.push({
      id: t.id,
      kind: 'task',
      projectId: t.projectId,
      title: t.title,
      state: workState(undefined, t),
      sessionId: null,
      taskId: t.id,
      workspaceId: listedWorkspace(t.workspaceId),
      ideaIds: [],
      prUrl: t.outputPrUrl ?? null,
      attentionReason: null,
    });
  }

  const machines: MapMachine[] = data.nodes.map((n) => ({
    id: n.id,
    placeholder: false,
    name: n.name,
    provider: n.cloudProvider,
    size: n.vmSize,
    location: n.vmLocation,
    status: n.status,
    health: n.healthStatus,
    workspaces: [],
  }));
  const machinesById = new Map(machines.map((m) => [m.id, m]));
  const placeholders = new Map<'instant' | 'unlisted', MapMachine>();
  const placeholderFor = (kind: 'instant' | 'unlisted') => {
    const entry = placeholders.get(kind) ?? placeholderMachine(kind);
    placeholders.set(kind, entry);
    return entry;
  };
  for (const w of data.workspaces) {
    // A node missing from the response may be stopped (the active map leaves those out),
    // past the entity cap, or deleted: the map cannot tell which, so it does not guess.
    const machine = w.nodeId
      ? (machinesById.get(w.nodeId) ?? placeholderFor('unlisted'))
      : placeholderFor('instant');
    machine.workspaces.push({
      id: w.id,
      projectId: w.projectId,
      machineId: machine.id,
      label: w.branch || w.displayName || w.id,
      status: w.status,
    });
  }
  for (const kind of ['instant', 'unlisted'] as const) {
    const entry = placeholders.get(kind);
    if (entry) machines.push(entry);
  }

  const projects: MapProject[] = data.projects.map((p) => ({
    id: p.id,
    name: p.name,
    repository: p.repository,
    lastActivityAt: p.lastActivityAt,
  }));
  // Work can belong to a project past the server's project cap; give it a row so it still
  // has somewhere to hang from, rather than floating or vanishing on phones.
  const listedProjects = new Set(projects.map((p) => p.id));
  for (const projectId of new Set(work.map((w) => w.projectId))) {
    if (listedProjects.has(projectId)) continue;
    projects.push({
      id: projectId,
      name: 'Project not listed',
      repository: null,
      lastActivityAt: null,
    });
    listedProjects.add(projectId);
  }

  return {
    projects,
    work,
    machines,
    ideas: new Map(
      data.ideas.map((i) => [i.id, { id: i.id, projectId: i.projectId, title: i.title }])
    ),
  };
}

export function machineOf(
  model: ConnectionsModel,
  workspaceId: string | null
): MapMachine | undefined {
  if (!workspaceId) return undefined;
  return model.machines.find((m) => m.workspaces.some((w) => w.id === workspaceId));
}

export function workspaceOf(
  model: ConnectionsModel,
  workspaceId: string | null
): MapWorkspace | undefined {
  return machineOf(model, workspaceId)?.workspaces.find((w) => w.id === workspaceId);
}

function matchesFilter(w: MapWork, filter: MapFilter): boolean {
  if (filter === 'attention') return w.state === 'needs-you' || w.state === 'failed';
  if (filter === 'live') return w.state === 'working' || w.state === 'needs-you';
  return true;
}

const includesQuery = (query: string, ...texts: Array<string | null | undefined>) =>
  texts.some((text) => text?.toLowerCase().includes(query));

function matchesQuery(model: ConnectionsModel, w: MapWork, query: string): boolean {
  if (!query) return true;
  const project = model.projects.find((p) => p.id === w.projectId);
  const machine = machineOf(model, w.workspaceId);
  return includesQuery(
    query,
    w.title,
    project?.name,
    project?.repository,
    workspaceOf(model, w.workspaceId)?.label,
    machine?.placeholder ? null : machine?.name,
    ...w.ideaIds.map((id) => model.ideas.get(id)?.title)
  );
}

/** What to draw for a filter and search: ordered so lines cross as little as possible. */
export function selectConnectionsView(
  model: ConnectionsModel,
  filter: MapFilter,
  rawQuery: string
): ConnectionsView {
  const query = rawQuery.trim().toLowerCase();
  const narrowed = filter !== 'all' || query !== '';
  const projectOrder = new Map(model.projects.map((p, i) => [p.id, i]));
  const work = model.work
    .filter((w) => matchesFilter(w, filter) && matchesQuery(model, w, query))
    .sort(
      (a, b) =>
        (projectOrder.get(a.projectId) ?? 0) - (projectOrder.get(b.projectId) ?? 0) ||
        STATE_ORDER[a.state] - STATE_ORDER[b.state]
    );

  // Search also finds projects and machines by their own names, even with no work on them.
  const searching = query !== '' && filter === 'all';
  const withWork = new Set(work.map((w) => w.projectId));
  const withWorkspaces = new Set(
    model.machines.flatMap((m) => m.workspaces.map((w) => w.projectId))
  );
  const projects = model.projects.filter(
    (p) =>
      withWork.has(p.id) ||
      (!narrowed && withWorkspaces.has(p.id)) ||
      (searching && includesQuery(query, p.name, p.repository))
  );
  const quietProjects = narrowed ? [] : model.projects.filter((p) => !projects.includes(p));

  const firstUse = new Map<string, number>();
  work.forEach((w, i) => {
    const m = machineOf(model, w.workspaceId);
    if (m && !firstUse.has(m.id)) firstUse.set(m.id, i);
  });
  const machines = model.machines
    .filter(
      (m) =>
        !narrowed ||
        firstUse.has(m.id) ||
        (searching &&
          includesQuery(query, m.placeholder ? null : m.name, ...m.workspaces.map((w) => w.label)))
    )
    .sort((a, b) => (firstUse.get(a.id) ?? Infinity) - (firstUse.get(b.id) ?? Infinity));

  const shownWorkspaces = new Set(machines.flatMap((m) => m.workspaces.map((w) => w.id)));
  const edges: MapEdge[] = [];
  for (const w of work) {
    const tone: MapEdge['tone'] =
      w.state === 'needs-you'
        ? 'attention'
        : w.state === 'failed'
          ? 'failed'
          : w.state === 'working'
            ? 'live'
            : 'quiet';
    edges.push({ from: w.projectId, to: w.id, tone });
    if (w.workspaceId && shownWorkspaces.has(w.workspaceId))
      edges.push({ from: w.id, to: w.workspaceId, tone });
  }
  return { projects, quietProjects, work, machines, edges };
}

/**
 * Everything upstream and downstream of one item, never sideways: picking a machine lights its
 * chats and their projects, but not the other chats of those projects. Workspaces count through
 * their own project too, so a workspace with no chat on the map still connects.
 */
export function chainOf(model: ConnectionsModel, id: string | null): Set<string> {
  const chain = new Set<string>();
  if (!id) return chain;
  chain.add(id);
  const machine = model.machines.find((m) => m.id === id);
  for (const w of model.work) {
    const ws = workspaceOf(model, w.workspaceId);
    const hit =
      w.id === id ||
      w.projectId === id ||
      ws?.id === id ||
      (machine !== undefined && ws?.machineId === machine.id);
    if (!hit) continue;
    chain.add(w.id).add(w.projectId);
    if (ws) chain.add(ws.id).add(ws.machineId);
  }
  for (const m of model.machines) {
    for (const ws of m.workspaces) {
      const owned = ws.projectId !== null && ws.projectId === id;
      if (m.id === id || owned || ws.id === id) {
        chain.add(ws.id).add(m.id);
        if (ws.projectId) chain.add(ws.projectId);
      }
    }
  }
  return chain;
}
