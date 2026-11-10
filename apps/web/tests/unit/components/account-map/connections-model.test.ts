import { describe, expect, it } from 'vitest';

import {
  buildConnectionsModel,
  chainOf,
  machineOf,
  NO_MACHINE_ID,
  selectConnectionsView,
  UNLISTED_MACHINE_ID,
} from '../../../../src/components/account-map/connections-model';
import { accountMapFixture } from './fixtures';

describe('buildConnectionsModel', () => {
  const model = buildConnectionsModel(accountMapFixture());
  const work = (id: string) => model.work.find((w) => w.id === id);

  it('merges a chat with its task so each piece of work appears once', () => {
    expect(model.work.map((w) => w.id).sort()).toEqual(['s-1', 's-2', 's-3', 's-4', 't-2', 't-3']);
    expect(work('s-1')).toMatchObject({
      kind: 'task',
      title: 'Show wake progress',
      taskId: 't-1',
      sessionId: 's-1',
      prUrl: 'https://github.com/o/r/pull/12',
    });
    expect(work('t-1')).toBeUndefined();
  });

  it('derives each state from the real fields', () => {
    expect(work('s-1')?.state).toBe('needs-you');
    expect(work('s-1')?.attentionReason).toBe('Which branch should I use?');
    expect(work('t-2')?.state).toBe('working');
    expect(work('t-3')?.state).toBe('failed');
    expect(work('s-4')?.state).toBe('asleep');
    expect(work('s-2')?.state).toBe('idle');
  });

  it("finds a chat's workspace through the workspace when the chat does not name it", () => {
    expect(work('s-3')?.workspaceId).toBe('w-3');
    expect(machineOf(model, work('s-3')?.workspaceId ?? null)?.id).toBe('n-2');
  });

  it('links ideas to the chats that work on them', () => {
    expect(work('s-1')?.ideaIds).toEqual(['i-1']);
    expect(work('s-2')?.ideaIds).toEqual([]);
  });

  it('groups workspaces under their machine, and machine-less ones under one Instant entry', () => {
    const byId = new Map(model.machines.map((m) => [m.id, m.workspaces.map((w) => w.id)]));
    expect(byId.get('n-1')).toEqual(['w-1', 'w-2']);
    expect(byId.get('n-2')).toEqual(['w-3']);
    expect(byId.get('n-3')).toEqual([]);
    expect(byId.get(NO_MACHINE_ID)).toEqual(['w-4']);
    expect(machineOf(model, 'w-4')?.placeholder).toBe('instant');
  });

  it('puts workspaces whose machine is not in the response under "Machine not listed", not Instant', () => {
    const base = accountMapFixture();
    const m = buildConnectionsModel(
      accountMapFixture({
        workspaces: [
          ...base.workspaces,
          {
            ...base.workspaces[0]!,
            id: 'w-stuck',
            nodeId: 'n-deleted',
            status: 'stopping',
            chatSessionId: null,
          },
        ],
      })
    );
    // Stopped, past the cap, or deleted: the map cannot tell which, so it does not say "gone".
    expect(machineOf(m, 'w-stuck')).toMatchObject({
      id: UNLISTED_MACHINE_ID,
      placeholder: 'unlisted',
      name: 'Machine not listed',
    });
    expect(machineOf(m, 'w-4')?.id).toBe(NO_MACHINE_ID);
  });

  // The ProjectData DO stores a failed chat as `failed` (never `error`), so a chat
  // with no task that failed was shown as idle (state-machine audit D4).
  it('shows a failed chat without a task as failed', () => {
    const fixture = accountMapFixture();
    const failed = buildConnectionsModel({
      ...fixture,
      sessions: fixture.sessions.map((s) => (s.id === 's-2' ? { ...s, status: 'failed' } : s)),
    });
    expect(failed.work.find((w) => w.id === 's-2')?.state).toBe('failed');
    // Liveness: the other chats keep their own states.
    expect(failed.work.find((w) => w.id === 's-4')?.state).toBe('asleep');
  });

  it('treats a cancelled or superseded task as done, not idle', () => {
    const m = buildConnectionsModel(
      accountMapFixture({
        sessions: [],
        tasks: [
          {
            ...accountMapFixture().tasks[1]!,
            id: 'c',
            status: 'cancelled',
            agentActivityState: 'awake-idle',
          },
          { ...accountMapFixture().tasks[1]!, id: 's', agentActivityState: 'superseded' },
        ],
      })
    );
    expect(m.work.map((w) => w.state)).toEqual(['done', 'done']);
  });

  it('treats a superseded task as done even when it failed', () => {
    const base = accountMapFixture();
    const m = buildConnectionsModel(
      accountMapFixture({
        sessions: [],
        tasks: [
          { ...base.tasks[1]!, id: 'old', status: 'failed', agentActivityState: 'superseded' },
        ],
      })
    );
    expect(m.work[0]?.state).toBe('done');
  });

  it('shows a retried task once, through its newest chat', () => {
    const base = accountMapFixture();
    const m = buildConnectionsModel(
      accountMapFixture({
        sessions: [
          { ...base.sessions[0]!, id: 's-new', taskId: 't-1', attention: null },
          { ...base.sessions[0]!, id: 's-old', taskId: 't-1' },
        ],
      })
    );
    expect(m.work.filter((w) => w.taskId === 't-1').map((w) => w.id)).toEqual(['s-new']);
  });

  it("uses the first of a chat's workspace candidates that is actually on the map", () => {
    const base = accountMapFixture();
    const m = buildConnectionsModel(
      accountMapFixture({
        sessions: [{ ...base.sessions[0]!, workspaceId: 'w-deleted' }],
      })
    );
    // s-1 names a deleted workspace; its task names w-1, which is listed.
    expect(m.work.find((w) => w.id === 's-1')?.workspaceId).toBe('w-1');
  });

  it("gives work from a project past the server's cap a placeholder project row", () => {
    const base = accountMapFixture();
    const m = buildConnectionsModel(
      accountMapFixture({ projects: base.projects.filter((p) => p.id !== 'p-ttv') })
    );
    expect(m.projects.find((p) => p.id === 'p-ttv')?.name).toBe('Project not listed');
    expect(selectConnectionsView(m, 'all', '').projects.map((p) => p.id)).toContain('p-ttv');
  });
});

describe('selectConnectionsView', () => {
  const model = buildConnectionsModel(accountMapFixture());

  it('shows everything, hiding projects with nothing on the map behind "quiet"', () => {
    const view = selectConnectionsView(model, 'all', '');
    expect(view.projects.map((p) => p.id)).toEqual(['p-sam', 'p-ttv']);
    expect(view.quietProjects.map((p) => p.id)).toEqual(['p-quiet']);
    expect(view.work).toHaveLength(6);
    // An idle machine still shows: it is infrastructure the user is paying for.
    expect(view.machines.map((m) => m.id)).toContain('n-3');
  });

  it('orders work by project, then waiting-on-you first', () => {
    const ids = selectConnectionsView(model, 'all', '').work.map((w) => w.id);
    expect(ids.slice(0, 2)).toEqual(['s-1', 't-3']);
    expect(ids.indexOf('t-2')).toBeGreaterThan(ids.indexOf('s-4'));
  });

  it('draws project → work and work → workspace lines, toned by state', () => {
    const { edges } = selectConnectionsView(model, 'all', '');
    expect(edges).toContainEqual({ from: 'p-sam', to: 's-1', tone: 'attention' });
    expect(edges).toContainEqual({ from: 's-1', to: 'w-1', tone: 'attention' });
    expect(edges).toContainEqual({ from: 't-2', to: 'w-2', tone: 'live' });
    expect(edges).toContainEqual({ from: 's-3', to: 'w-3', tone: 'quiet' });
    // Failed task with no workspace: only its project line, in the failure tone (never amber).
    expect(edges.filter((e) => e.from === 't-3' || e.to === 't-3')).toEqual([
      { from: 'p-sam', to: 't-3', tone: 'failed' },
    ]);
  });

  it('"Needs you" keeps waiting and failed work, and only the machines it runs on', () => {
    const view = selectConnectionsView(model, 'attention', '');
    expect(view.work.map((w) => w.id)).toEqual(['s-1', 't-3']);
    expect(view.projects.map((p) => p.id)).toEqual(['p-sam']);
    expect(view.quietProjects).toEqual([]);
    expect(view.machines.map((m) => m.id)).toEqual(['n-1']);
  });

  it('"Live" keeps working and waiting work', () => {
    expect(selectConnectionsView(model, 'live', '').work.map((w) => w.id)).toEqual(['s-1', 't-2']);
  });

  it('search matches titles, ideas, branches and machine names', () => {
    expect(selectConnectionsView(model, 'all', 'subtitle').work.map((w) => w.id)).toEqual(['t-2']);
    expect(selectConnectionsView(model, 'all', 'WAKE PROGRESS YOU').work.map((w) => w.id)).toEqual([
      's-1',
    ]);
    expect(selectConnectionsView(model, 'all', 'lobby-reconnect').work.map((w) => w.id)).toEqual([
      's-3',
    ]);
    expect(selectConnectionsView(model, 'all', 'hel1-02').work.map((w) => w.id)).toEqual(['s-3']);
    const none = selectConnectionsView(model, 'all', 'nothing matches this');
    expect(none.work).toEqual([]);
    expect(none.machines).toEqual([]);
  });

  it('search finds projects and machines by name even with no work on them', () => {
    const quiet = selectConnectionsView(model, 'all', 'quiet project');
    expect(quiet.work).toEqual([]);
    expect(quiet.projects.map((p) => p.id)).toEqual(['p-quiet']);
    const idle = selectConnectionsView(model, 'all', 'nbg1-03');
    expect(idle.machines.map((m) => m.id)).toEqual(['n-3']);
  });
});

describe('chainOf', () => {
  const model = buildConnectionsModel(accountMapFixture());

  it("lights a chat's project, workspace and machine", () => {
    expect([...chainOf(model, 's-1')].sort()).toEqual(['n-1', 'p-sam', 's-1', 'w-1']);
  });

  it("lights a machine's chats and their projects, but not sibling chats of those projects", () => {
    const chain = chainOf(model, 'n-1');
    for (const id of ['n-1', 'w-1', 'w-2', 's-1', 't-2', 'p-sam', 'p-ttv'])
      expect(chain.has(id)).toBe(true);
    for (const id of ['s-3', 's-4', 't-3', 'n-2']) expect(chain.has(id)).toBe(false);
  });

  it('lights everything a project runs, and nothing from other projects', () => {
    const chain = chainOf(model, 'p-sam');
    for (const id of ['s-1', 's-3', 's-4', 't-3', 'w-1', 'w-3', 'n-1', 'n-2'])
      expect(chain.has(id)).toBe(true);
    for (const id of ['t-2', 'w-2', 'p-ttv', 's-2']) expect(chain.has(id)).toBe(false);
  });

  it('connects a workspace to its project even when no chat on the map runs in it', () => {
    const base = accountMapFixture();
    const m = buildConnectionsModel(
      accountMapFixture({
        workspaces: [
          ...base.workspaces,
          {
            ...base.workspaces[0]!,
            id: 'w-idle',
            nodeId: 'n-3',
            chatSessionId: null,
            projectId: 'p-quiet',
          },
        ],
      })
    );
    const fromProject = chainOf(m, 'p-quiet');
    expect(fromProject.has('w-idle')).toBe(true);
    expect(fromProject.has('n-3')).toBe(true);
    expect(chainOf(m, 'n-3').has('p-quiet')).toBe(true);
  });

  it('is empty with nothing picked', () => {
    expect(chainOf(model, null).size).toBe(0);
  });
});
