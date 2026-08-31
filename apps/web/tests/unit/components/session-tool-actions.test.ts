/**
 * Unit coverage for the pure helpers in `session-tool-actions.ts`.
 *
 * `buildSessionToolActions` itself is exercised through the rail (Playwright audit) and
 * the hook; what lives here is the logic that has no other direct owner — the strip-mode
 * cycle order, the mode guard, and the group-divider predicate.
 */
import { describe, expect, it } from 'vitest';

import {
  type BuildSessionToolActionsInput,
  buildSessionToolActions,
  DEFAULT_TOOL_STRIP_MODE,
  isToolGroupStart,
  isToolStripMode,
  nextToolStripMode,
  type SessionToolAction,
  TOOL_STRIP_MODES,
  type ToolStripMode,
} from '../../../src/components/project-message-view/session-tool-actions';

describe('nextToolStripMode', () => {
  /*
   * The rail computes the next mode itself (`SessionToolRail.tsx` calls this and hands the
   * result to `onModeChange`), so this function IS the cycle order — nothing else encodes
   * it. If it stopped wrapping, the cycle button would dead-end on `hidden` and the only
   * way back would be the peek tab.
   */
  it('cycles icons → labels → hidden → icons', () => {
    expect(nextToolStripMode('icons')).toBe('labels');
    expect(nextToolStripMode('labels')).toBe('hidden');
    expect(nextToolStripMode('hidden')).toBe('icons');
  });

  it('returns to the starting mode after a full lap of every mode', () => {
    // Guards the wrap generically: if a fourth mode is ever added, a cycle that fails to
    // include it fails here rather than silently stranding the new mode.
    let mode: ToolStripMode = DEFAULT_TOOL_STRIP_MODE;
    for (let i = 0; i < TOOL_STRIP_MODES.length; i += 1) {
      mode = nextToolStripMode(mode);
    }
    expect(mode).toBe(DEFAULT_TOOL_STRIP_MODE);
  });

  it('visits every mode exactly once per lap', () => {
    const seen = new Set<ToolStripMode>();
    let mode: ToolStripMode = DEFAULT_TOOL_STRIP_MODE;
    for (let i = 0; i < TOOL_STRIP_MODES.length; i += 1) {
      seen.add(mode);
      mode = nextToolStripMode(mode);
    }
    expect(seen.size).toBe(TOOL_STRIP_MODES.length);
    expect([...seen].sort()).toEqual([...TOOL_STRIP_MODES].sort());
  });
});

describe('isToolStripMode', () => {
  it('accepts every declared mode', () => {
    for (const mode of TOOL_STRIP_MODES) {
      expect(isToolStripMode(mode)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    // This guard is what stops a corrupted or stale localStorage value from putting the
    // rail into an unrenderable state on load.
    for (const bad of [null, undefined, '', 'ICONS', 'compact', '0', 'null']) {
      expect(isToolStripMode(bad)).toBe(false);
    }
  });
});

describe('isToolGroupStart', () => {
  const action = (id: string, group: SessionToolAction['group']): SessionToolAction =>
    ({ id, group }) as SessionToolAction;

  const actions = [
    action('files', 'workspace'),
    action('git', 'workspace'),
    action('retry', 'session'),
    action('report', 'meta'),
  ];

  it('never reports the first action as a group start', () => {
    // A divider above the first row would float against the rail's top edge.
    expect(isToolGroupStart(actions, 0)).toBe(false);
  });

  it('is false within a group and true at a boundary', () => {
    expect(isToolGroupStart(actions, 1)).toBe(false); // git follows files
    expect(isToolGroupStart(actions, 2)).toBe(true); // session follows workspace
    // Generic-function coverage only: the rail filters `meta` out before calling this, so
    // a meta boundary cannot occur in production. Asserted so the helper stays correct if
    // a future surface renders the ungrouped list.
    expect(isToolGroupStart(actions, 3)).toBe(true);
  });

  it('is false for an out-of-range index', () => {
    expect(isToolGroupStart(actions, actions.length)).toBe(false);
    expect(isToolGroupStart([], 0)).toBe(false);
  });
});

describe('buildSessionToolActions — group assignment', () => {
  /** Every gate open, so all ten tools are present. */
  const fullInput = (): BuildSessionToolActionsInput => ({
    session: { id: 's1', workspaceId: 'ws1', taskId: 't1' } as never,
    sessionState: 'active',
    taskEmbed: { id: 't1', status: 'in_progress' } as never,
    reportEnabled: true,
    unresolvedCommentCount: 2,
    needsAttentionCommentCount: 1,
    hasFilesHandler: true,
    hasGitHandler: true,
    hasTimelineHandler: true,
    hasCommentsHandler: true,
    hasRetryHandler: true,
    hasForkHandler: true,
  });

  /*
   * `SessionToolRail` partitions on `action.group` rather than on position, so a tool
   * carrying the wrong group is silently relocated — a `meta` typo moves it into the
   * pinned footer no matter where it sits in the concat. `withGroup` makes that
   * unrepresentable, and this pins the mapping so a future refactor cannot reintroduce
   * per-action group literals without failing here.
   */
  it('assigns each tool to the group its builder owns', () => {
    const byId = new Map(buildSessionToolActions(fullInput()).map((a) => [a.id, a.group]));

    for (const id of ['files', 'git', 'workspace', 'timeline', 'comments'] as const) {
      expect(byId.get(id)).toBe('workspace');
    }
    for (const id of ['retry', 'fork'] as const) {
      expect(byId.get(id)).toBe('session');
    }
    for (const id of ['report', 'complete', 'details'] as const) {
      expect(byId.get(id)).toBe('meta');
    }
  });

  it('emits groups in workspace → session → meta order, never interleaved', () => {
    // The workspace → session boundary is the only divider `isToolGroupStart` can draw in
    // production (the rail filters `meta` out before calling it), so a group appearing
    // twice would either duplicate that divider or suppress it.
    const groups = buildSessionToolActions(fullInput()).map((a) => a.group);
    const firstSeen = [...new Set(groups)];
    expect(firstSeen).toEqual(['workspace', 'session', 'meta']);
    // No group reappears after another has started.
    expect(groups).toEqual([...groups].sort((a, b) => firstSeen.indexOf(a) - firstSeen.indexOf(b)));
  });
});
