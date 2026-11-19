import { describe, expect, it } from 'vitest';

import { resolveWorkStartPlan, workStartRelationFor } from '../src/work-start';

describe('resolveWorkStartPlan', () => {
  it('uses the profile when no skill is chosen', () => {
    expect(
      resolveWorkStartPlan({
        profile: { runtime: 'vm', taskMode: 'task', workspaceProfile: 'full' },
      })
    ).toEqual({ taskMode: 'task', capability: 'task-execution' });
  });

  it('lets a skill override the profile, as resolveSkillProfile does', () => {
    expect(
      resolveWorkStartPlan({
        profile: { runtime: 'vm', taskMode: 'task', workspaceProfile: 'full' },
        skill: {
          runtime: 'cf-container',
          taskMode: 'conversation',
          workspaceProfile: 'lightweight',
        },
      })
    ).toEqual({ taskMode: 'conversation', capability: 'conversation' });
  });

  it('keeps the profile value for a field the skill leaves unset', () => {
    expect(
      resolveWorkStartPlan({
        profile: { runtime: 'vm', taskMode: 'task', workspaceProfile: 'full' },
        skill: { runtime: null, taskMode: null, workspaceProfile: null },
      }).taskMode
    ).toBe('task');
  });

  // The workspace profile is not returned, so it is observed through the mode it decides
  // when nothing sets one explicitly.
  it("falls back to the project's default workspace profile to decide an unset mode", () => {
    expect(
      resolveWorkStartPlan({
        profile: { runtime: null, taskMode: null, workspaceProfile: null },
        projectDefaultWorkspaceProfile: 'lightweight',
      }).taskMode
    ).toBe('conversation');
    expect(
      resolveWorkStartPlan({
        profile: { runtime: null, taskMode: null, workspaceProfile: null },
        projectDefaultWorkspaceProfile: 'full',
      }).taskMode
    ).toBe('task');
  });

  // The submit path passes `taskModeDefault: 'workspace-profile'`, so an unset task mode
  // follows the workspace profile. A lightweight workspace means a conversation.
  it('derives an unset task mode from the resolved workspace profile', () => {
    expect(
      resolveWorkStartPlan({
        profile: { runtime: null, taskMode: null, workspaceProfile: 'lightweight' },
      }).taskMode
    ).toBe('conversation');
    expect(
      resolveWorkStartPlan({
        profile: { runtime: null, taskMode: null, workspaceProfile: 'full' },
      }).taskMode
    ).toBe('task');
  });

  it("a skill's workspace profile outranks the profile's when deciding an unset mode", () => {
    expect(
      resolveWorkStartPlan({
        profile: { runtime: null, taskMode: null, workspaceProfile: 'full' },
        skill: { runtime: null, taskMode: null, workspaceProfile: 'lightweight' },
      }).taskMode
    ).toBe('conversation');
  });

  it('uses the full workspace profile default when nothing sets one', () => {
    expect(resolveWorkStartPlan({ profile: { runtime: null, taskMode: null } })).toEqual({
      taskMode: 'task',
      capability: 'task-execution',
    });
  });

  // `submitInstantTask` honours a `task` mode inside a container, so claiming a
  // cf-container profile can only converse would be a lie about a real capability.
  it('does not force a cf-container profile to conversation', () => {
    expect(
      resolveWorkStartPlan({
        profile: { runtime: 'cf-container', taskMode: 'task', workspaceProfile: 'lightweight' },
      })
    ).toEqual({ taskMode: 'task', capability: 'task-execution' });
  });

  it('ignores values outside the known enums', () => {
    expect(
      resolveWorkStartPlan({
        profile: { runtime: null, taskMode: 'nonsense', workspaceProfile: 'nonsense' },
        projectDefaultWorkspaceProfile: 'lightweight',
      }).taskMode
    ).toBe('conversation');
  });

  it('handles no profile at all', () => {
    expect(resolveWorkStartPlan({}).capability).toBe('task-execution');
  });
});

describe('workStartRelationFor', () => {
  it('maps task work to the strong works_on relation', () => {
    expect(workStartRelationFor('task')).toBe('works_on');
  });

  it('maps a conversation to the weak discusses relation', () => {
    expect(workStartRelationFor('conversation')).toBe('discusses');
  });
});
