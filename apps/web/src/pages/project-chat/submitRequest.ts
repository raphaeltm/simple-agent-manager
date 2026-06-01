import type { TaskMode, VMSize, WorkspaceProfile } from '@simple-agent-manager/shared';

import type { TaskAttachmentRef } from '../../lib/api';
import type { submitTask } from '../../lib/api';
import type { PendingDerived } from './useProjectChatState';

type SubmitTaskPayload = Parameters<typeof submitTask>[1];

function getDerivedSubmitFields(pendingDerived: PendingDerived | null) {
  if (!pendingDerived) return {};
  return { parentTaskId: pendingDerived.parentTaskId, contextSummary: pendingDerived.contextSummary };
}

export function buildBaseSubmitRequest({
  message,
  agentProfileId,
  skillId,
  selectedAgentType,
  selectedVmSize,
  selectedWorkspaceProfile,
  selectedDevcontainerConfigName,
  selectedTaskMode,
  pendingDerived,
}: Readonly<{
  message: string;
  agentProfileId: string | null;
  skillId: string | null;
  selectedAgentType: string | null;
  selectedVmSize: VMSize;
  selectedWorkspaceProfile: WorkspaceProfile;
  selectedDevcontainerConfigName: string;
  selectedTaskMode: TaskMode;
  pendingDerived: PendingDerived | null;
}>): SubmitTaskPayload {
  const derivedFields = getDerivedSubmitFields(pendingDerived);
  if (agentProfileId) return { message, agentProfileId, ...(skillId ? { skillId } : {}), ...derivedFields };

  const devcontainerConfigName = selectedDevcontainerConfigName.trim();
  return {
    message,
    ...(selectedAgentType ? { agentType: selectedAgentType } : {}),
    ...(skillId ? { skillId } : {}),
    vmSize: selectedVmSize,
    workspaceProfile: selectedWorkspaceProfile,
    ...(selectedWorkspaceProfile !== 'lightweight' && devcontainerConfigName ? { devcontainerConfigName } : {}),
    taskMode: selectedTaskMode,
    ...derivedFields,
  };
}

export function getCompletedAttachmentRefs(attachments: Array<{ status: string; ref?: TaskAttachmentRef | null }>) {
  return attachments.reduce<TaskAttachmentRef[]>((refs, attachment) => {
    if (attachment.status === 'complete' && attachment.ref) refs.push(attachment.ref);
    return refs;
  }, []);
}

export function withAttachmentRefs(baseRequest: SubmitTaskPayload, attachmentRefs: TaskAttachmentRef[]): SubmitTaskPayload {
  if (attachmentRefs.length === 0) return baseRequest;
  return { ...baseRequest, attachments: attachmentRefs };
}
