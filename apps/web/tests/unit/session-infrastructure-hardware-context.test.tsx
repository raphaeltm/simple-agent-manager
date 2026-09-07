import { renderHook, waitFor } from '@testing-library/react';
import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';
import { useSessionInfrastructure } from '../../src/components/project-message-view/useSessionInfrastructure';
const api = vi.hoisted(() => ({ getWorkspace: vi.fn(), getNode: vi.fn() }));
vi.mock('../../src/lib/api', () => api);

describe('session infrastructure identity', () => {
  it('clears the previous host immediately when switching sessions, even before new API reads finish', async () => {
    const firstWorkspace = { id: 'ws-first', nodeId: 'node-first' } as WorkspaceResponse;
    const firstNode = { id: 'node-first', observedProviderInstanceVcpuCount: 12 } as NodeResponse;
    api.getWorkspace.mockImplementation((id: string) =>
      id === 'ws-first' ? Promise.resolve(firstWorkspace) : new Promise(() => {})
    );
    api.getNode.mockResolvedValue(firstNode);
    const { result, rerender } = renderHook(({ id }) => useSessionInfrastructure(id), {
      initialProps: { id: 'ws-first' },
    });
    await waitFor(() => expect(result.current.node?.id).toBe('node-first'));
    rerender({ id: 'ws-second' });
    expect(result.current.workspace).toBeNull();
    expect(result.current.node).toBeNull();
  });
});
