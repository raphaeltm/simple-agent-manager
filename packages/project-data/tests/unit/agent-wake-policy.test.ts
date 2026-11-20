import { describe, expect, it } from 'vitest';

import {
  agentWakeRecord,
  decideAgentWake,
  DEFAULT_AGENT_WAKE_POLICY_MODE,
  HUMAN_AGENT_WAKE_TRIGGERS,
  HUMAN_PROMPT_DELIVERY_TRIGGERS,
} from '../../src/do/agent-wake-policy';
import { SESSION_WRITER_PROMPT_SOURCES } from '../../src/do/session-access-store';

const base = { sessionId: 'session-1', trigger: 'comment_directive' as const };

describe('agent wake policy (trusted_project)', () => {
  it('is the default mode', () => {
    expect(DEFAULT_AGENT_WAKE_POLICY_MODE).toBe('trusted_project');
  });

  it('lets the session owner wake their own agent, not as teammate input', () => {
    expect(
      decideAgentWake({
        ...base,
        actorUserId: 'owner-1',
        access: { role: 'owner', ownerUserId: 'owner-1', grantId: null },
      })
    ).toEqual({
      allowed: true,
      mode: 'trusted_project',
      trigger: 'comment_directive',
      sessionId: 'session-1',
      actorUserId: 'owner-1',
      onBehalfOfUserId: 'owner-1',
      actorRole: 'owner',
      grantId: null,
      teammateInput: false,
    });
  });

  it('lets an active grantee wake it, on the owner’s behalf, as teammate input', () => {
    expect(
      decideAgentWake({
        ...base,
        actorUserId: 'teammate-1',
        access: { role: 'grantee', ownerUserId: 'owner-1', grantId: 'grant-1' },
      })
    ).toMatchObject({
      allowed: true,
      actorUserId: 'teammate-1',
      onBehalfOfUserId: 'owner-1',
      actorRole: 'grantee',
      grantId: 'grant-1',
      teammateInput: true,
    });
  });

  it.each([
    ['a project member with no grant', { role: 'none', ownerUserId: 'owner-1', grantId: null }],
    ['a grantee whose grant is gone', { role: 'grantee', ownerUserId: 'owner-1', grantId: null }],
    [
      'anyone on a session with no recorded owner',
      { role: 'owner', ownerUserId: null, grantId: null },
    ],
  ] as const)('refuses %s', (_label, access) => {
    expect(
      decideAgentWake({ ...base, trigger: 'user_followup', actorUserId: 'member-1', access })
    ).toEqual({
      allowed: false,
      mode: 'trusted_project',
      trigger: 'user_followup',
      reason: 'not_session_writer',
    });
  });

  it('records who woke the agent and for whom', () => {
    const wake = decideAgentWake({
      ...base,
      actorUserId: 'teammate-1',
      access: { role: 'grantee', ownerUserId: 'owner-1', grantId: 'grant-1' },
    });
    if (!wake.allowed) throw new Error('expected a grant');
    expect(agentWakeRecord(wake)).toEqual({
      trigger: 'comment_directive',
      policyMode: 'trusted_project',
      triggeredByUserId: 'teammate-1',
      onBehalfOfUserId: 'owner-1',
      actorRole: 'grantee',
      teammateInput: true,
      grantId: 'grant-1',
    });
  });

  it('owns the list of prompt sources the delivery fence checks', () => {
    expect(SESSION_WRITER_PROMPT_SOURCES).toBe(HUMAN_PROMPT_DELIVERY_TRIGGERS);
    // Attention answers go straight to the live agent, so they are a wake but not a queued source.
    expect(HUMAN_AGENT_WAKE_TRIGGERS).toEqual([
      'user_followup',
      'inbox_reply',
      'comment_directive',
      'attention_answer',
      'inbox_task_comment',
    ]);
  });
});

describe('agent wake policy: a comment on a human task (inbox slice H1)', () => {
  const task = (assigneeUserId: string | null, claimedByUserId: string | null) => ({
    sessionId: 'session-1',
    trigger: 'inbox_task_comment' as const,
    inboxTask: { assigneeUserId, claimedByUserId },
  });
  const none = { role: 'none' as const, ownerUserId: 'owner-1', grantId: null };

  it('wakes for the assignee, labelled teammate input', () => {
    expect(
      decideAgentWake({ ...task('maya', null), actorUserId: 'maya', access: none })
    ).toMatchObject({ allowed: true, actorRole: 'assignee', teammateInput: true });
  });

  it('wakes for the member who took a team task', () => {
    expect(
      decideAgentWake({ ...task(null, 'jonas'), actorUserId: 'jonas', access: none })
    ).toMatchObject({ allowed: true, actorRole: 'assignee', onBehalfOfUserId: 'owner-1' });
  });

  it('records only for any other member with no rights on the chat', () => {
    expect(
      decideAgentWake({ ...task('maya', 'jonas'), actorUserId: 'lee', access: none })
    ).toMatchObject({ allowed: false, reason: 'not_session_writer' });
  });

  it('never matches a null assignee or claimer', () => {
    expect(
      decideAgentWake({ ...task(null, null), actorUserId: 'lee', access: none })
    ).toMatchObject({ allowed: false });
  });

  it('still wakes for the chat owner, not as teammate input', () => {
    expect(
      decideAgentWake({
        ...task('maya', null),
        actorUserId: 'owner-1',
        access: { role: 'owner', ownerUserId: 'owner-1', grantId: null },
      })
    ).toMatchObject({ allowed: true, actorRole: 'owner', teammateInput: false });
  });

  it('ignores the task fields for every other trigger', () => {
    expect(
      decideAgentWake({
        sessionId: 'session-1',
        trigger: 'comment_directive',
        inboxTask: { assigneeUserId: 'maya', claimedByUserId: null },
        actorUserId: 'maya',
        access: none,
      })
    ).toMatchObject({ allowed: false });
  });
});
