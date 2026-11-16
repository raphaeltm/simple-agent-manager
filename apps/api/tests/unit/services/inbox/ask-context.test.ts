/**
 * The "since" side of the ask context counts the work the agent did after asking, including a
 * tool run that started before the ask and finished after it (found on staging: the agent called
 * request_human_input and request_secret in one tool run, and the second call was not counted).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const edges = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock('../../../../src/services/project-data', () => ({
  getLogicalTranscriptPage: edges.page,
}));
vi.mock('../../../../src/services/collaboration-settings', () => ({
  getCommentContextLimits: vi.fn().mockResolvedValue({ messages: 6, maxRows: 500 }),
}));
vi.mock('../../../../src/services/connector-read-settings', () => ({
  getConnectorReadLimits: vi.fn().mockResolvedValue({
    transcriptScanRows: 4000,
    transcriptMessageChars: 6000,
    transcriptPageChars: 24000,
  }),
}));

import type { Env } from '../../../../src/env';
import { readAskContext } from '../../../../src/services/inbox/ask-context';

const ASKED = 1_000;
const message = (id: string, createdAt: number) => ({
  kind: 'message',
  messageId: id,
  role: 'assistant',
  content: `text ${id}`,
  createdAt,
  updatedAt: createdAt,
  truncated: false,
  complete: true,
});
const activity = (createdAt: number, updatedAt: number, toolCalls: number) => ({
  kind: 'activity',
  createdAt,
  updatedAt,
  toolCalls,
});

/** The newest page (`before: null`) and the page before the ask, by the request's cursor. */
function pages(result: { latest: unknown; before: unknown }) {
  edges.page.mockImplementation((...args: unknown[]) => {
    const request = args[3] as { before: unknown } | undefined;
    return Promise.resolve(request?.before === null ? result.latest : result.before);
  });
}

describe('readAskContext since side', () => {
  beforeEach(() => edges.page.mockReset());

  it('returns messages after the ask and counts tool runs after it, including one spanning the ask', async () => {
    pages({
      latest: {
        // Newest first.
        entries: [
          message('after-2', 1_400),
          activity(1_200, 1_300, 3),
          message('after-1', 1_100),
          activity(900, 1_050, 2),
          message('before-1', 800),
        ],
        hasMore: false,
        scanBudgetExhausted: false,
      },
      before: { entries: [message('before-1', 800)], hasMore: false, scanBudgetExhausted: false },
    });
    const context = await readAskContext({} as Env, {
      projectId: 'p',
      sessionId: 's',
      askedAt: ASKED,
    });
    expect(context.before.map((entry) => entry.id)).toEqual(['before-1']);
    expect(context.since.messages.map((entry) => entry.id)).toEqual(['after-1', 'after-2']);
    // 3 tool calls after the ask, plus the run that straddled it.
    expect(context.since.activityCount).toBe(4);
    expect(context.since.truncated).toBe(false);
  });

  it('says when more happened after the ask than the page reaches', async () => {
    pages({
      latest: { entries: [message('after-9', 5_000)], hasMore: true, scanBudgetExhausted: false },
      before: { entries: [], hasMore: false, scanBudgetExhausted: false },
    });
    const context = await readAskContext({} as Env, {
      projectId: 'p',
      sessionId: 's',
      askedAt: ASKED,
    });
    expect(context.since).toMatchObject({ truncated: true, activityCount: 0 });
  });
});
