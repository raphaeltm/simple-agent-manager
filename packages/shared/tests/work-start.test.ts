import { describe, expect, it } from 'vitest';

import { resolveWorkStartPlan, workStartRelationFor } from '../src/work-start';

describe('resolveWorkStartPlan', () => {
  it('uses the profile when no skill is chosen', () => {
    expect(
      resolveWorkStartPlan({
        profile: { runtime: 'vm', taskMode: 'task', workspaceProfile: 'full' },
      })
    ).toEqual({
      runtime: 'vm',
      workspaceProfile: 'full',
      taskMode: 'task',
      capability: 'task-execution',
    });
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
    ).toEqual({
      runtime: 'cf-container',
      workspaceProfile: 'lightweight',
      taskMode: 'conversation',
      capability: 'conversation',
    });
  });

  it('keeps the profile value for a field the skill leaves unset', () => {
    const plan = resolveWorkStartPlan({
      profile: { runtime: 'vm', taskMode: 'task', workspaceProfile: 'full' },
      skill: { runtime: null, taskMode: null, workspaceProfile: null },
    });
    expect(plan.runtime).toBe('vm');
    expect(plan.taskMode).toBe('task');
    expect(plan.workspaceProfile).toBe('full');
  });

  it('falls back to the project default workspace profile', () => {
    const plan = resolveWorkStartPlan({
      profile: { runtime: null, taskMode: null, workspaceProfile: null },
      projectDefaultWorkspaceProfile: 'lightweight',
    });
    expect(plan.workspaceProfile).toBe('lightweight');
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

  it('uses the full workspace profile default when nothing sets one', () => {
    const plan = resolveWorkStartPlan({ profile: { runtime: null, taskMode: null } });
    expect(plan.workspaceProfile).toBe('full');
    expect(plan.taskMode).toBe('task');
  });

  // `submitInstantTask` honours `taskMode: 'task'` inside a container, so claiming a
  // cf-container profile can only converse would be a lie about a real capability.
  it('does not force a cf-container profile to conversation', () => {
    const plan = resolveWorkStartPlan({
      profile: { runtime: 'cf-container', taskMode: 'task', workspaceProfile: 'lightweight' },
    });
    expect(plan.runtime).toBe('cf-container');
    expect(plan.taskMode).toBe('task');
    expect(plan.capability).toBe('task-execution');
  });

  it('ignores values outside the known enums', () => {
    const plan = resolveWorkStartPlan({
      profile: { runtime: null, taskMode: 'nonsense', workspaceProfile: 'nonsense' },
      projectDefaultWorkspaceProfile: 'lightweight',
    });
    expect(plan.workspaceProfile).toBe('lightweight');
    expect(plan.taskMode).toBe('conversation');
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
