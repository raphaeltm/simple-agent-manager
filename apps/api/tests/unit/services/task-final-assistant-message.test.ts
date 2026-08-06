import { describe, expect, it, vi } from 'vitest';

import { getLatestAssistantMessageForTask } from '../../../src/services/task-final-assistant-message';

vi.mock('../../../src/services/project-data', () => ({
  getMessages: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { warn: vi.fn() },
}));

import * as projectDataService from '../../../src/services/project-data';

const mockGetMessages = vi.mocked(projectDataService.getMessages);
const mockEnv = {} as Parameters<typeof getLatestAssistantMessageForTask>[0];

describe('getLatestAssistantMessageForTask', () => {
  it('returns null when sessionId is null', async () => {
    const result = await getLatestAssistantMessageForTask(mockEnv, 'proj-1', null);
    expect(result).toBeNull();
    expect(mockGetMessages).not.toHaveBeenCalled();
  });

  it('returns null when no assistant messages exist', async () => {
    mockGetMessages.mockResolvedValue({ messages: [], hasMore: false });

    const result = await getLatestAssistantMessageForTask(mockEnv, 'proj-1', 'session-1');
    expect(result).toBeNull();
  });

  it('returns null when the assistant message has empty content', async () => {
    mockGetMessages.mockResolvedValue({
      messages: [{ id: 'msg-1', role: 'assistant', content: '   ', createdAt: 1000 }],
      hasMore: false,
    });

    const result = await getLatestAssistantMessageForTask(mockEnv, 'proj-1', 'session-1');
    expect(result).toBeNull();
  });

  it('returns null when the assistant message has non-string content', async () => {
    mockGetMessages.mockResolvedValue({
      messages: [{ id: 'msg-1', role: 'assistant', content: 42 as unknown as string, createdAt: 1000 }],
      hasMore: false,
    });

    const result = await getLatestAssistantMessageForTask(mockEnv, 'proj-1', 'session-1');
    expect(result).toBeNull();
  });

  it('returns the latest assistant message with bounded content', async () => {
    mockGetMessages.mockResolvedValue({
      messages: [{ id: 'msg-latest', role: 'assistant', content: 'Final findings here', createdAt: 1710000002000 }],
      hasMore: false,
    });

    const result = await getLatestAssistantMessageForTask(mockEnv, 'proj-1', 'session-1');
    expect(result).toEqual({
      id: 'msg-latest',
      content: 'Final findings here',
      createdAt: 1710000002000,
    });
  });

  it('requests messages with limit=1 and order=desc to get the newest', async () => {
    mockGetMessages.mockResolvedValue({
      messages: [{ id: 'msg-newest', role: 'assistant', content: 'Latest output', createdAt: 1710000005000 }],
      hasMore: false,
    });

    await getLatestAssistantMessageForTask(mockEnv, 'proj-1', 'session-1');
    expect(mockGetMessages).toHaveBeenCalledWith(
      mockEnv,
      'proj-1',
      'session-1',
      1,
      null,
      ['assistant'],
      false,
      'desc',
    );
  });

  it('truncates content exceeding 2000 characters', async () => {
    const longContent = 'x'.repeat(2500);
    mockGetMessages.mockResolvedValue({
      messages: [{ id: 'msg-long', role: 'assistant', content: longContent, createdAt: 1000 }],
      hasMore: false,
    });

    const result = await getLatestAssistantMessageForTask(mockEnv, 'proj-1', 'session-1');
    expect(result).not.toBeNull();
    expect(result!.content).toHaveLength(2003);
    expect(result!.content.endsWith('...')).toBe(true);
  });

  it('returns null and logs a warning when getMessages throws', async () => {
    mockGetMessages.mockRejectedValue(new Error('ProjectData unavailable'));

    const result = await getLatestAssistantMessageForTask(mockEnv, 'proj-1', 'session-1');
    expect(result).toBeNull();
  });
});
