/**
 * The stalled-task classifiers are Workers AI calls. On a runtime without the AI binding they
 * must answer "no verdict" without reading the transcript and without leaving a timer armed
 * that rejects later as an unhandled rejection (the scheduled stuck-task sweep calls these on
 * every pass for every long-running task).
 *
 * The admin switch is left at its default (enabled): the absence under test is the binding, not
 * the switch. Each absent case has a control with the binding present on the same fixture, so a
 * "returns null" result cannot be satisfied by the age gates or the switch.
 */
import { DEFAULT_STALLED_TASK_CLASSIFIER_TIMEOUT_MS } from '@simple-agent-manager/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  classifyLongRunningTaskStall,
  classifyReconciliationLoop,
} from '../../../src/scheduled/stalled-task-classifier';
import type { TaskRuntimeLiveness } from '../../../src/services/task-runtime-liveness';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const projectData = vi.hoisted(() => ({
  getMessages: vi.fn(),
  hasPendingSessionHumanInput: vi.fn(),
  hasUnexpiredHumanInput: vi.fn(),
}));

// Durable Object boundaries: the ProjectData transcript store and the interaction store.
vi.mock('../../../src/services/project-data', () => ({
  getMessages: projectData.getMessages,
  hasPendingSessionHumanInput: projectData.hasPendingSessionHumanInput,
}));
vi.mock('../../../src/services/acp-interaction-store', () => ({
  hasUnexpiredHumanInput: projectData.hasUnexpiredHumanInput,
}));

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');

const task = {
  id: 'task-long-1',
  project_id: 'project-1',
  workspace_id: 'ws-1',
  chat_session_id: 'chat-1',
};

/** A turn that has been prompting for two hours, well past the default activity-age gate. */
const liveness = {
  live: true,
  conclusive: true,
  reason: 'task_prompt_turn_active',
  workspaceStatus: 'running',
  nodeId: 'node-1',
  activeAcpSessionId: 'agent-1',
  evidence: {
    workState: 'prompt_turn_active',
    activity: 'prompting',
    lastActivityAgeMs: 0,
    promptStartedAgeMs: 2 * HOUR,
    runtimeWorkProgressAgeMs: null,
    acpHeartbeatAgeMs: 0,
  },
} as unknown as TaskRuntimeLiveness;

/** A transcript that has been silent for two hours: old tool output, then nothing. */
const silentTranscript = [
  {
    id: 'msg-2',
    role: 'tool',
    content: 'npm run build',
    createdAt: NOW - 2 * HOUR,
  },
  {
    id: 'msg-1',
    role: 'user',
    content: 'Please build the project.',
    createdAt: NOW - 3 * HOUR,
  },
];

const stalledVerdict = {
  answers: {
    stall_status: { value: 'stalled', probabilities: { stalled: 0.99 } },
    reason: { value: 'transcript_silent' },
  },
};

let sqlite: Database.Database;
let baseEnv: Env;
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  ({ sqlite, env: baseEnv } = createAdminSettingsEnv());
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  projectData.getMessages.mockReset().mockResolvedValue({ messages: silentTranscript, hasMore: false });
  projectData.hasPendingSessionHumanInput.mockReset().mockResolvedValue(false);
  projectData.hasUnexpiredHumanInput.mockReset().mockResolvedValue(false);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.useRealTimers();
  sqlite.close();
});

function withAi(run: ReturnType<typeof vi.fn>): Env {
  return { ...baseEnv, AI: { run } } as unknown as Env;
}

describe('classifyLongRunningTaskStall', () => {
  it('with Workers AI present reads the transcript and returns the model verdict (Cloudflare behaviour)', async () => {
    const run = vi.fn().mockResolvedValue(stalledVerdict);

    const result = await classifyLongRunningTaskStall(withAi(run), {
      task,
      liveness,
      nowMs: NOW,
    });

    expect(result).toMatchObject({
      decision: 'stalled',
      reason: 'transcript_silent',
      transcriptMessageCount: 2,
    });
    expect(projectData.getMessages).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('without Workers AI returns null before reading any messages', async () => {
    const result = await classifyLongRunningTaskStall(baseEnv, { task, liveness, nowMs: NOW });

    expect(result).toBeNull();
    expect(projectData.getMessages).not.toHaveBeenCalled();
    expect(projectData.hasPendingSessionHumanInput).not.toHaveBeenCalled();
  });

  it('without Workers AI leaves no timer behind that rejects after the classifier timeout', async () => {
    vi.useFakeTimers({ now: NOW });

    const result = await classifyLongRunningTaskStall(baseEnv, { task, liveness, nowMs: NOW });
    expect(result).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    // Run every timer the call could have armed, then let rejections surface as process events.
    await vi.advanceTimersByTimeAsync(DEFAULT_STALLED_TASK_CLASSIFIER_TIMEOUT_MS * 3);
    vi.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).toEqual([]);
  });

  it('treats an AI binding without a run method as absent', async () => {
    const result = await classifyLongRunningTaskStall(
      { ...baseEnv, AI: {} } as unknown as Env,
      { task, liveness, nowMs: NOW }
    );

    expect(result).toBeNull();
    expect(projectData.getMessages).not.toHaveBeenCalled();
  });
});

describe('classifyReconciliationLoop', () => {
  const checkIns = [
    { role: 'user', content: 'Checking in: any progress?', createdAt: NOW - HOUR },
    { role: 'assistant', content: 'Still working on it.', createdAt: NOW - HOUR + 1000 },
  ];

  it('with Workers AI present returns the advisory verdict (Cloudflare behaviour)', async () => {
    const run = vi.fn().mockResolvedValue(stalledVerdict);

    const result = await classifyReconciliationLoop(withAi(run), checkIns);

    expect(result).toMatchObject({ decision: 'stalled', reason: 'transcript_silent' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('without Workers AI returns null and arms no timeout', async () => {
    vi.useFakeTimers({ now: NOW });

    const result = await classifyReconciliationLoop(baseEnv, checkIns);

    expect(result).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_STALLED_TASK_CLASSIFIER_TIMEOUT_MS * 3);
    vi.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });
});
