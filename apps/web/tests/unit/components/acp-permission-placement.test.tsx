import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { DisplayItem } from '../../../src/components/project-message-view/tool-call-groups';
import { useAcpPermissionPlacement } from '../../../src/components/project-message-view/useAcpPermissionPlacement';
import type { AcpInteractionSnapshotItem } from '../../../src/lib/api/acp-interactions';

const row = (id: string, timestamp: number): DisplayItem => ({
  kind: 'agent_message',
  id,
  timestamp,
  text: id,
  streaming: false,
});
const request = (
  overrides: Partial<AcpInteractionSnapshotItem> = {}
): AcpInteractionSnapshotItem => ({
  interactionId: 'permission',
  kind: 'permission',
  state: 'delivery_confirmed',
  createdAt: 20,
  deadlineAt: 100,
  ...overrides,
});
const params = {
  projectId: 'project',
  sessionId: 'session',
  canAnswer: true,
  onRefresh: vi.fn(),
};

function place(displayItems: DisplayItem[], interactions: AcpInteractionSnapshotItem[]) {
  return renderHook(() => useAcpPermissionPlacement({ ...params, displayItems, interactions }))
    .result.current;
}

describe('permission placement in paginated conversation history', () => {
  it.each([null, 'tool-not-in-transcript'])(
    'keeps settled requests in history when anchor is %s',
    (toolCallId) => {
      const interaction = request({ toolCallId });
      const { result, rerender } = renderHook(
        ({ displayItems }) =>
          useAcpPermissionPlacement({
            ...params,
            displayItems,
            interactions: [interaction],
          }),
        { initialProps: { displayItems: [row('before', 10), row('after', 30)] } }
      );
      expect(result.current.anchored.get('before')).toEqual([interaction]);
      expect(result.current.unanchored).toEqual([]);
      rerender({ displayItems: [row('before', 10), row('after', 30), row('new-activity', 40)] });
      expect(result.current.anchored.get('before')).toEqual([interaction]);
      expect(result.current.unanchored).toEqual([]);
    }
  );

  it('reveals older settled requests only after their history is loaded', () => {
    const interaction = request();
    expect(place([row('newer', 30)], [interaction]).anchored.size).toBe(0);
    expect(place([row('newer', 30)], [interaction]).unanchored).toEqual([]);
    expect(
      place([row('older', 10), row('newer', 30)], [interaction]).anchored.get('older')
    ).toEqual([interaction]);
  });

  it('keeps unmatched pending requests visible even outside loaded history', () => {
    const interaction = request({ state: 'pending' });
    expect(place([row('newer', 30)], [interaction]).unanchored).toEqual([interaction]);
    expect(place([], [interaction]).unanchored).toEqual([interaction]);
    expect(place([], [request()]).unanchored).toEqual([]);
  });

  it('prefers the exact tool group anchor over timestamp fallback', () => {
    const interaction = request({ toolCallId: 'tool' });
    const group: DisplayItem = {
      kind: 'tool_call_group',
      id: 'group',
      timestamp: 5,
      items: [
        {
          kind: 'tool_call',
          id: 'tool-row',
          toolCallId: 'tool',
          timestamp: 5,
          title: 'Command',
          status: 'completed',
          content: [],
          locations: [],
        },
      ],
    };
    expect(place([group, row('later', 10)], [interaction]).anchored.get('group')).toEqual([
      interaction,
    ]);
  });

  it('handles an in-place updated plan whose timestamp is newer than following rows', () => {
    const interaction = request();
    expect(
      place(
        [row('updated-plan', 100), row('before', 10), row('after', 30)],
        [interaction]
      ).anchored.get('before')
    ).toEqual([interaction]);
    expect(
      place(
        [row('before', 10), row('updated-plan', 100), row('nearer', 15)],
        [interaction]
      ).anchored.get('nearer')
    ).toEqual([interaction]);
  });

  it('uses creation time rather than delivery time and keeps a receipt at the current tail', () => {
    const interaction = request({ updatedAt: 60 });
    expect(place([row('before', 10)], [interaction]).anchored.get('before')).toEqual([interaction]);
    expect(
      place(
        [row('before', 10), row('at-request', 20), row('later', 30)],
        [interaction]
      ).anchored.get('at-request')
    ).toEqual([interaction]);
  });
});
