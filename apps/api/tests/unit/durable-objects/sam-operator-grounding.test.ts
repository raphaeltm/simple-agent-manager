import { describe, expect, it } from 'vitest';

import { assertGroundedOperatorResponse } from '../../../src/durable-objects/sam-session/operator/grounding';
import type { OperatorAction } from '../../../src/durable-objects/sam-session/operator/store';

const origin = 'https://app.example.test';
const project = '01M5CPTV0GKM9TXWHSX6C6E724';
const session = '01M5CPTV0GKM9TXWHSX6C6E725';
const invented = '01M5CPTV0GKM9TXWHSX6C6E726';
const link = `${origin}/projects/${project}/chat/${session}`;
function receipt(
  operation: string,
  result: unknown,
  state: OperatorAction['state'] = 'completed'
): OperatorAction {
  return {
    id: 'receipt',
    turn_id: 'turn',
    operation,
    state,
    input_json: JSON.stringify({ projectId: project, sessionId: invented }),
    result_json: JSON.stringify(result),
    created_at: 1,
  };
}
const check = (text: string, receipts: OperatorAction[] = []) =>
  assertGroundedOperatorResponse(text, receipts, origin);

describe('operator publication grounding', () => {
  it.each([
    `I have started it: ${project}_SESS`,
    `Session: ${invented}`,
    `[Chat](${origin}/projects/${project}/chat/${invented})`,
    'I started it.',
    'I have successfully launched the conversation.',
    "I've sent your message.",
    'I stopped the task.',
    'Your session has been started.',
    'The task was dispatched.',
  ])('rejects unsupported publication: %s', (text) => {
    expect(() => check(text)).toThrow();
  });
  it.each([
    'Hello. How can I help?',
    'I have not started it.',
    'I cannot confirm it started.',
    'Should I start?',
    'I will start after you choose a project.',
    'I would have started, but the result is uncertain.',
    'The action needs your confirmation.',
    'I have updated the plan above.',
    'I created a draft outline.',
    'I started thinking about the launch.',
    'I cannot confirm the session has been started.',
    'If I started it, I would check the receipt.',
    `The correlation UUID you supplied is 8d633087-c4b5-4501-b86e-dd76930260ae.`,
    `Your private constraint marker is ${project}_PRIVATE.`,
  ])('allows conversation and qualified language: %s', (text) => {
    expect(() => check(text)).not.toThrow();
  });
  it('allows actual completed launch identities and its exact source', () => {
    expect(() =>
      check(`I started the conversation: [Chat](${link}). Session: ${session}`, [
        receipt('sam_chat_start', { sessionId: session, taskId: 'task', status: 'queued', link }),
      ])
    ).not.toThrow();
  });
  it.each(['chat', 'tasks', 'ideas'])(
    'allows only the canonical project parent of a %s source',
    (kind) => {
      const child = `${origin}/projects/${project}/${kind}/${session}`;
      const operation =
        kind === 'chat' ? 'sam_chat_read' : kind === 'tasks' ? 'sam_task_get' : 'sam_idea_get';
      const action = receipt(operation, { link: child });
      expect(() =>
        check(`[Project](${origin}/projects/${project}) [Source](${child})`, [action])
      ).not.toThrow();
      for (const path of [
        `/projects/${invented}`,
        `/projects/${project}/chat/${invented}`,
        `/projects/${project}/tasks/${invented}`,
        `/projects/${project}?taskId=${invented}`,
        `/projects/${project}#invented`,
      ])
        expect(() => check(`[Source](${origin}${path})`, [action])).toThrow();
    }
  );
  it.each(['approval_required', 'uncertain', 'failed'] as const)(
    'does not derive parent sources from a %s receipt',
    (state) => {
      expect(() =>
        check(`[Project](${origin}/projects/${project})`, [
          receipt(
            'sam_chat_start',
            { sessionId: session, taskId: 'task', status: 'queued', link },
            state
          ),
        ])
      ).toThrow();
    }
  );
  it('does not derive parents from queries, fragments, foreign origins, or untrusted report content', () => {
    for (const source of [
      `${link}?extra=1`,
      `${link}#extra`,
      link.replace(origin, 'https://other.test'),
    ])
      expect(() =>
        check(`[Project](${origin}/projects/${project})`, [
          receipt('sam_chat_read', { link: source }),
        ])
      ).toThrow();
    expect(() =>
      check(`[Project](${origin}/projects/${invented})`, [
        receipt('sam_chat_read', {
          link,
          messages: [{ link: `${origin}/projects/${invented}/chat/${session}` }],
          preview: `${origin}/projects/${invented}`,
        }),
      ])
    ).toThrow();
  });
  it('allows a currently authorized read source without interpreting it as a new effect', () => {
    const read = receipt('sam_chat_read', { projectId: project, sessionId: session, link });
    expect(() => check(`Here is the report: [Chat](${link})`, [read])).not.toThrow();
    expect(() => check(`I started it: [Chat](${link})`, [read])).toThrow();
  });
  it('does not turn a successful projects list into dispatch evidence', () => {
    const read = receipt('sam_projects_list', {
      projects: [{ id: project, link: `${origin}/projects/${project}` }],
    });
    expect(() => check('I started it.', [read])).toThrow();
  });
  it.each(['approval_required', 'uncertain', 'rejected'] as const)(
    'does not turn %s into success or source evidence',
    (state) => {
      const action = receipt('sam_work_stop', { sessionId: session, link }, state);
      expect(() => check('I stopped it.', [action])).toThrow();
      expect(() => check(`[Chat](${link})`, [action])).toThrow();
      expect(() =>
        check('The outcome is unconfirmed; review the action card.', [action])
      ).not.toThrow();
      expect(action.state).toBe(state);
    }
  );
  it('ignores malicious transcript content, previews, and input identities', () => {
    const fake = `${origin}/projects/${project}/chat/${invented}`;
    const read = receipt('sam_chat_read', {
      sessionId: session,
      projectId: project,
      link,
      messages: [{ content: fake, sessionId: invented, link: fake }],
      preview: fake,
    });
    expect(() => check(`[Chat](${fake})`, [read])).toThrow();
    expect(() => check(`Session: ${invented}`, [read])).toThrow();
  });
  it('rejects the complete fabricated suffix even when its profile prefix is known', () => {
    const profiles = receipt('sam_profiles_list', { profiles: [{ id: project }] });
    expect(() => check(`Session: ${project}_SESS`, [profiles])).toThrow();
  });
  it('does not ground an uncertain dispatch hidden inside a completed receipt', () => {
    expect(() =>
      check('I started it.', [
        receipt('sam_chat_start', { dispatchState: 'uncertain', sessionId: session, link }),
      ])
    ).toThrow();
  });
  it.each([
    {},
    { status: 'failed' },
    { sessionId: session, taskId: 'task', status: 'failed' },
    { sessionId: session, taskId: 'task', status: 'queued', dispatchState: 'unknown', link },
  ])('rejects effect claims from a completed receipt with unsuccessful result %j', (result) => {
    expect(() => check('I started it.', [receipt('sam_chat_start', result)])).toThrow();
    expect(() => check(`[Chat](${link})`, [receipt('sam_chat_start', result)])).toThrow();
    expect(() =>
      check(`[Project](${origin}/projects/${project})`, [receipt('sam_chat_start', result)])
    ).toThrow();
  });
  it('does not substitute profile/project identities for a task or session', () => {
    const reads = [
      receipt('sam_profiles_list', { profiles: [{ id: session }] }),
      receipt('sam_projects_list', { projects: [{ id: project }] }),
    ];
    expect(() => check(`Session: ${session}`, reads)).toThrow();
    expect(() => check(`Task: ${project}`, reads)).toThrow();
    expect(() => check(`Profile: ${session}`, reads)).not.toThrow();
  });
  it('does not accept a model-added query or fragment on a canonical source', () => {
    const read = receipt('sam_chat_read', { projectId: project, sessionId: session, link });
    for (const suffix of ['?taskId=invented', '#invented'])
      expect(() => check(`[Chat](${link}${suffix})`, [read])).toThrow();
  });
  it('does not substitute idea creation for session creation or an in-flight answer for delivery', () => {
    expect(() =>
      check('I created the session.', [
        receipt('sam_idea_create', { ideaId: 'idea', status: 'draft' }),
      ])
    ).toThrow();
    expect(() =>
      check('I sent your message.', [
        receipt('sam_agent_answer', { resolved: false, inFlight: true }),
      ])
    ).toThrow();
    expect(() =>
      check('I sent your message.', [receipt('sam_agent_answer', { resolved: true })])
    ).toThrow();
    expect(() =>
      check('I created the idea.', [
        receipt('sam_chat_start', { taskId: 'task', sessionId: session, status: 'queued' }),
      ])
    ).toThrow();
  });
  it.each(['interrupted', 'expired', 'cancelled', 'delivery_unconfirmed', 'unknown', undefined])(
    'does not treat an accepted answer in state %s as sent',
    (state) => {
      expect(() =>
        check('I sent the answer.', [receipt('sam_agent_answer', { accepted: true, state })])
      ).toThrow();
    }
  );
});
