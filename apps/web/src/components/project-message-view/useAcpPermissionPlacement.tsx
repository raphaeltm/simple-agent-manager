import { useCallback, useMemo } from 'react';

import type { AcpInteractionSnapshotItem } from '../../lib/api/acp-interactions';
import { AcpPermissionCard } from './AcpPermissionCard';
import type { DisplayItem } from './tool-call-groups';

function placeInteractions(
  displayItems: DisplayItem[],
  interactions: AcpInteractionSnapshotItem[]
) {
  const rowIdByToolCallId = new Map<string, string>();
  for (const item of displayItems) {
    if (item.kind === 'tool_call') rowIdByToolCallId.set(item.toolCallId, item.id);
    if (item.kind === 'tool_call_group') {
      for (const grouped of item.items) {
        if (grouped.kind === 'tool_call') rowIdByToolCallId.set(grouped.toolCallId, item.id);
      }
    }
  }
  const anchored = new Map<string, AcpInteractionSnapshotItem[]>();
  const unanchored: AcpInteractionSnapshotItem[] = [];
  for (const interaction of interactions) {
    const rowId = interaction.toolCallId
      ? rowIdByToolCallId.get(interaction.toolCallId)
      : undefined;
    if (!rowId) {
      unanchored.push(interaction);
      continue;
    }
    const rowInteractions = anchored.get(rowId);
    if (rowInteractions) rowInteractions.push(interaction);
    else anchored.set(rowId, [interaction]);
  }
  return { anchored, unanchored };
}

function PermissionStack(props: {
  interactions: AcpInteractionSnapshotItem[];
  projectId: string;
  sessionId: string;
  canAnswer: boolean;
  onRefresh: () => Promise<unknown>;
}) {
  const { interactions, projectId, sessionId, canAnswer, onRefresh } = props;
  return (
    <div className="min-w-0" data-testid="acp-permission-stack">
      {interactions.map((interaction) => (
        <AcpPermissionCard
          key={interaction.interactionId}
          interaction={interaction}
          projectId={projectId}
          sessionId={sessionId}
          canAnswer={canAnswer}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  );
}

export function useAcpPermissionPlacement(params: {
  displayItems: DisplayItem[];
  interactions: AcpInteractionSnapshotItem[];
  projectId: string;
  sessionId: string;
  canAnswer: boolean;
  onRefresh: () => Promise<unknown>;
}) {
  const { displayItems, interactions, projectId, sessionId, canAnswer, onRefresh } = params;
  const placement = useMemo(
    () => placeInteractions(displayItems, interactions),
    [displayItems, interactions]
  );
  const render = useCallback(
    (items: AcpInteractionSnapshotItem[]) => (
      <PermissionStack
        interactions={items}
        projectId={projectId}
        sessionId={sessionId}
        canAnswer={canAnswer}
        onRefresh={onRefresh}
      />
    ),
    [canAnswer, onRefresh, projectId, sessionId]
  );
  return { ...placement, render };
}
