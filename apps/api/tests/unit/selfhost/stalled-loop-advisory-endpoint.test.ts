/**
 * A3b (overnight B3): the reconciliation-loop advisory verdict on the admin's OpenAI-compatible
 * endpoint when there is no Workers AI (Clef). Real admin settings store; the endpoint is stubbed
 * at fetch.
 *
 * - Off by default (`operations.stalledTaskClassifierEndpointAdvisory`), with no request sent.
 * - On: the endpoint's JSON verdict is returned; `stalled` below the confidence threshold is
 *   reported `uncertain`, as on the Clef path.
 * - The long-turn classifier, which can fail a live task, never uses the endpoint.
 * - Cloudflare control: with the binding, Clef answers and the endpoint is not called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  classifyLongRunningTaskStall,
  classifyReconciliationLoop,
} from '../../../src/scheduled/stalled-task-classifier';
import { updateAdminSettings } from '../../../src/services/admin-settings-mutations';
import { __resetAdminSettingsCacheForTest } from '../../../src/services/admin-settings-resolution';
import type { TaskRuntimeLiveness } from '../../../src/services/task-runtime-liveness';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

vi.mock('../../../src/services/project-data', () => ({
  getMessages: vi.fn(async () => ({ messages: [] })),
  hasPendingSessionHumanInput: vi.fn(async () => false),
}));
vi.mock('../../../src/services/acp-interaction-store', () => ({
  hasUnexpiredHumanInput: vi.fn(async () => false),
}));

const fetchMock = vi.fn();
const MESSAGES = [
  {
    role: 'assistant',
    content: 'Checking in: build failed again with the same error.',
    createdAt: 1,
  },
  {
    role: 'assistant',
    content: 'Checking in: build failed again with the same error.',
    createdAt: 2,
  },
];

function endpointAnswer(verdict: Record<string, unknown>): Response {
  return Response.json({
    choices: [{ message: { role: 'assistant', content: JSON.stringify(verdict) } }],
  });
}

async function boxEnv(advisory: boolean, overrides: Partial<Env> = {}): Promise<Env> {
  const { env } = createAdminSettingsEnv(overrides);
  await updateAdminSettings(env, {
    changes: [
      { name: 'llm.openAICompatible.baseUrl', value: 'https://llm.example.com/v1' },
      { name: 'llm.openAICompatible.model', value: 'small-model' },
      { name: 'operations.stalledTaskClassifierEndpointAdvisory', value: advisory },
    ],
    actorUserId: 'admin-1',
  });
  __resetAdminSettingsCacheForTest();
  return env;
}

beforeEach(() => {
  __resetAdminSettingsCacheForTest();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reconciliation-loop advisory verdict on the LLM endpoint', () => {
  it('is off by default: no verdict and no request', async () => {
    const env = await boxEnv(false);
    expect(await classifyReconciliationLoop(env, MESSAGES)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the endpoint verdict when an admin turns it on', async () => {
    const env = await boxEnv(true);
    fetchMock.mockResolvedValueOnce(
      endpointAnswer({ decision: 'stalled', confidence: 0.97, reason: 'repeated_error' })
    );

    expect(await classifyReconciliationLoop(env, MESSAGES)).toEqual({
      decision: 'stalled',
      confidence: 0.97,
      reason: 'repeated_error',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: { content: string }[];
    };
    expect(body.model).toBe('small-model');
    expect(body.messages[1]?.content).toContain('build failed again');
  });

  it('reports a low-confidence "stalled" as uncertain, like the Clef path', async () => {
    const env = await boxEnv(true);
    fetchMock.mockResolvedValueOnce(
      endpointAnswer({ decision: 'stalled', confidence: 0.2, reason: 'repeated_error' })
    );
    expect(await classifyReconciliationLoop(env, MESSAGES)).toMatchObject({
      decision: 'uncertain',
    });
  });

  it('answers no verdict when the endpoint fails', async () => {
    const env = await boxEnv(true);
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    expect(await classifyReconciliationLoop(env, MESSAGES)).toBeNull();
  });

  it('never classifies a live long turn through the endpoint (it can fail tasks)', async () => {
    const env = await boxEnv(true);
    const liveness = {
      live: true,
      conclusive: true,
      reason: 'task_prompt_turn_active',
      evidence: { promptStartedAgeMs: 10 * 3_600_000 },
    } as unknown as TaskRuntimeLiveness;

    const verdict = await classifyLongRunningTaskStall(env, {
      task: { id: 't1', project_id: 'p1', workspace_id: 'w1', chat_session_id: 'c1' },
      liveness,
      nowMs: Date.now(),
    });
    expect(verdict).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses Clef when the Workers AI binding exists (Cloudflare control)', async () => {
    const ai = {
      run: vi.fn(async () => ({
        answers: {
          stall_status: { value: 'still_working', probabilities: { still_working: 0.9 } },
          reason: { value: 'external_operation_pending' },
        },
      })),
    };
    const env = await boxEnv(true, { AI: ai as unknown as Ai });

    expect(await classifyReconciliationLoop(env, MESSAGES)).toMatchObject({
      decision: 'still_working',
    });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
