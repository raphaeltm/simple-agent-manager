import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { useAvailableCommands } from '../../../src/hooks/useAvailableCommands';

// Mock the API module
const mockGetCachedCommands = vi.fn();
const mockSaveCachedCommands = vi.fn();

vi.mock('../../../src/lib/api', () => ({
  getCachedCommands: (...args: unknown[]) => mockGetCachedCommands(...args),
  saveCachedCommands: (...args: unknown[]) => mockSaveCachedCommands(...args),
}));

// Mock acp-client exports
vi.mock('@simple-agent-manager/acp-client', () => ({
  CLIENT_COMMANDS: [
    { name: 'new-chat', description: 'Start a new chat', source: 'client' },
  ],
  getAllStaticCommands: () => [
    { name: 'compact', description: 'Compact conversation', source: 'agent' },
    { name: 'help', description: 'Show help', source: 'agent' },
  ],
  getStaticCommands: () => [],
}));

describe('useAvailableCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedCommands.mockResolvedValue({ commands: [] });
    mockSaveCachedCommands.mockResolvedValue({ cached: 0 });
  });

  it('fetches cached commands on mount', async () => {
    mockGetCachedCommands.mockResolvedValue({
      commands: [{ name: 'review-pr', description: 'Review a PR' }],
    });

    const { result } = renderHook(() => useAvailableCommands('proj-1'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockGetCachedCommands).toHaveBeenCalledWith('proj-1');
    expect(result.current.commands.find((c) => c.name === 'review-pr')).toBeDefined();
  });

  it('starts with isLoading=true and transitions to false', async () => {
    let resolveApi: (value: unknown) => void;
    mockGetCachedCommands.mockReturnValue(new Promise((r) => { resolveApi = r; }));

    const { result } = renderHook(() => useAvailableCommands('proj-1'));

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveApi!({ commands: [] });
    });

    expect(result.current.isLoading).toBe(false);
  });

  it('returns static + client commands even when API fails', async () => {
    mockGetCachedCommands.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useAvailableCommands('proj-1'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Static and client commands should still be present
    expect(result.current.commands.find((c) => c.name === 'compact')).toBeDefined();
    expect(result.current.commands.find((c) => c.name === 'new-chat')).toBeDefined();
    expect(result.current.commands.find((c) => c.name === 'help')).toBeDefined();
  });

  it('deduplicates with priority: live > cached > static > client', async () => {
    mockGetCachedCommands.mockResolvedValue({
      commands: [
        { name: 'help', description: 'Cached help' },
        { name: 'cached-only', description: 'Only in cache' },
      ],
    });

    const liveCommands = [
      { name: 'help', description: 'Live help', source: 'agent' as const },
    ];

    const { result } = renderHook(() =>
      useAvailableCommands('proj-1', liveCommands),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // 'help' should have live description (highest priority)
    const helpCmd = result.current.commands.find((c) => c.name === 'help');
    expect(helpCmd?.description).toBe('Live help');

    // cached-only should still be present
    expect(result.current.commands.find((c) => c.name === 'cached-only')).toBeDefined();

    // client command should still be present
    expect(result.current.commands.find((c) => c.name === 'new-chat')).toBeDefined();

    // static 'compact' should still be present
    expect(result.current.commands.find((c) => c.name === 'compact')).toBeDefined();
  });

  it('persistCommands calls saveCachedCommands', async () => {
    const { result } = renderHook(() => useAvailableCommands('proj-1'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.persistCommands('claude-code', [
        { name: 'do', description: 'Execute task', source: 'agent' },
      ]);
      // Allow dynamic import to resolve
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(mockSaveCachedCommands).toHaveBeenCalledWith('proj-1', 'claude-code', [
      { name: 'do', description: 'Execute task' },
    ]);
  });

  it('does not re-fetch for same projectId', async () => {
    const { result, rerender } = renderHook(
      ({ pid }) => useAvailableCommands(pid),
      { initialProps: { pid: 'proj-1' } },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    rerender({ pid: 'proj-1' });

    // Should only have been called once
    expect(mockGetCachedCommands).toHaveBeenCalledTimes(1);
  });
});
