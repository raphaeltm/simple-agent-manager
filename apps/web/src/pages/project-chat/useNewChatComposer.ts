/**
 * The new-chat composer's state and its one start path: message, profile choice, skill,
 * attachments, per-chat options and the request that starts the chat (Instant or task).
 *
 * Shared by the project chat page and the Project Overview's task box, so both start work
 * the same way. The start returns what it created and leaves navigation to the caller: the
 * chat page opens the new chat, the Overview stays put and shows a receipt.
 */
import type { TaskMode, WorkspaceProfile } from '@simple-agent-manager/shared';
import { DEFAULT_WORKSPACE_PROFILE, hasByocComputeCredential } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { selectProfileId } from '../../components/project-chat/profile-picker/model';
import {
  hasAnyResourceValue,
  toResourceRequirements,
} from '../../components/resource-requirements';
import { useAgentCatalog } from '../../hooks/useAgentCatalog';
import { useCredentials } from '../../hooks/useCredentials';
import { useQueryScope } from '../../hooks/useQueryScope';
import { useTrialStatus } from '../../hooks/useTrialStatus';
import { getTranscribeApiUrl, startInstantChatSession, submitTask } from '../../lib/api';
import { useProjectContext } from '../ProjectContext';
import {
  buildBaseSubmitRequest,
  getCompletedAttachmentRefs,
  withAttachmentRefs,
} from './submitRequest';
import type { PendingDerived } from './types';
import { DEFAULT_ATTACHMENT_MESSAGE, useAttachments } from './useAttachments';
import { useComposerOverrides } from './useComposerOverrides';
import { useProfileChoice } from './useProfileChoice';
import { useProjectSkills } from './useProjectSkills';

/** What a successful start created. */
export type NewChatStart =
  | { kind: 'instant'; sessionId: string; message: string; profileId: string }
  | {
      kind: 'task';
      sessionId: string;
      taskId: string;
      branchName: string;
      message: string;
      profileId: string;
    };

export function useNewChatComposer() {
  const { projectId, project } = useProjectContext();
  const queryScope = useQueryScope();

  // Credentials, platform compute availability, the agent catalog and agent profiles all come
  // from shared TanStack queries, so the settings pages and onboarding reuse the same reads.
  const { credentials, loading: credentialsLoading } = useCredentials(queryScope);
  // "Is there compute this user may provision on": their own cloud account, or the installation's
  // machines. Not the SAM-managed AI proxy (`available`), which is off on installs that provide
  // machines but leave agent credentials to each user; keying on it refused every send there.
  const { platformCompute, loading: platformComputeLoading } = useTrialStatus(queryScope);
  const hasUserCloudCredentials = hasByocComputeCredential(credentials);
  const hasCloudCredentials = hasUserCloudCredentials || platformCompute;
  // The composer refuses only once both reads have answered "no". A send while either is still
  // in flight goes to the server, which decides placement itself; refusing then would tell a
  // user with compute that they have none.
  const computeKnownAbsent = !hasCloudCredentials && !credentialsLoading && !platformComputeLoading;

  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { agents: agentCatalog } = useAgentCatalog(queryScope);
  const configuredAgents = useMemo(
    () => agentCatalog.filter((agent) => agent.configured && agent.supportsAcp),
    [agentCatalog]
  );
  const [selectedAgentType, setSelectedAgentType] = useState<string | null>(null);

  // Fill in a default agent type once one is available, never overriding a choice
  // (`.claude/rules/06-technical-patterns.md`, interaction-effect analysis).
  useEffect(() => {
    const firstAgent = configuredAgents[0];
    if (!firstAgent) return;
    setSelectedAgentType((current) => current ?? firstAgent.id);
  }, [configuredAgents]);

  // Profiles, the person's picker state and pre-selection, the picker sheet and the
  // inline create-profile wizard.
  const profileChoice = useProfileChoice({
    projectId,
    queryScope,
    configuredAgents,
    selectedAgentType,
  });
  const {
    agentProfiles,
    selectedProfileId,
    openProfileWizard,
    profilePicker: { picker: profilePickerInput, refresh: refreshProfilePicker },
  } = profileChoice;
  const { skills, selectedSkillId, setSelectedSkillId } = useProjectSkills(projectId);

  const attachments = useAttachments(projectId, setSubmitError);

  // Workspace profile selection — defaults to project setting or platform default
  const [selectedWorkspaceProfile, setSelectedWorkspaceProfile] = useState<WorkspaceProfile>(
    (project?.defaultWorkspaceProfile as WorkspaceProfile | null) ?? DEFAULT_WORKSPACE_PROFILE
  );
  // Devcontainer config name — empty string means auto-detect
  const [selectedDevcontainerConfigName, setSelectedDevcontainerConfigName] = useState(
    project?.defaultDevcontainerConfigName ?? ''
  );

  // Task mode selection — defaults based on workspace profile
  const [selectedTaskMode, setSelectedTaskMode] = useState<TaskMode>(
    ((project?.defaultWorkspaceProfile as WorkspaceProfile | null) ?? DEFAULT_WORKSPACE_PROFILE) ===
      'lightweight'
      ? 'conversation'
      : 'task'
  );
  const userSetTaskModeRef = useRef(false);
  useEffect(() => {
    if (!userSetTaskModeRef.current) {
      setSelectedTaskMode(selectedWorkspaceProfile === 'lightweight' ? 'conversation' : 'task');
    }
  }, [selectedWorkspaceProfile]);
  const handleTaskModeChange = useCallback((mode: TaskMode) => {
    userSetTaskModeRef.current = true;
    setSelectedTaskMode(mode);
  }, []);

  // Per-chat resource, model and effort overrides — blank fields inherit from profile/project
  const overrides = useComposerOverrides(projectId);
  const { taskResourceReqs, resetComposerOverrides, validateTaskResources, agentOverrideFields } =
    overrides;

  const transcribeApiUrl = useMemo(() => getTranscribeApiUrl(), []);

  const resolveProfileIdForSubmit = useCallback(async () => {
    if (selectedProfileId) return selectedProfileId;
    if (configuredAgents.length === 0) {
      setSubmitError('Add an agent in Settings before starting a chat.');
      return null;
    }
    if (agentProfiles.length > 0) {
      // Sent before the picker state arrived: same default rule, without waiting for it.
      const fallback = profilePickerInput.status === 'ready' ? profilePickerInput : null;
      return selectProfileId(null, agentProfiles, fallback ?? { status: 'unavailable' });
    }

    openProfileWizard();
    setSubmitError('Create a profile before sending your first message.');
    return null;
  }, [
    agentProfiles,
    configuredAgents.length,
    openProfileWizard,
    profilePickerInput,
    selectedProfileId,
  ]);

  /**
   * Start a chat from the composer. Returns what it created, after clearing the composer, or
   * null when it refused or failed (the reason is in `submitError`). Never navigates.
   */
  const startNewChat = async (
    pendingDerived: PendingDerived | null
  ): Promise<NewChatStart | null> => {
    const trimmed =
      message.trim() || (attachments.chatAttachments.length > 0 ? DEFAULT_ATTACHMENT_MESSAGE : '');
    if (!trimmed) return null;
    if (attachments.chatAttachments.some((a) => a.status !== 'complete')) {
      setSubmitError('Please wait for file uploads to complete');
      return null;
    }
    setSubmitError(null);

    // Validate resource overrides before dispatch and surface per-field errors
    if (!validateTaskResources()) {
      setSubmitError('Fix resource requirement errors before sending');
      return null;
    }
    const hasResources = hasAnyResourceValue(taskResourceReqs);

    setSubmitting(true);
    try {
      const submitProfileId = await resolveProfileIdForSubmit();
      if (!submitProfileId) return null;

      const selectedProfile =
        agentProfiles.find((profile) => profile.id === submitProfileId) ?? null;
      const selectedSkill = selectedSkillId
        ? (skills.find((skill) => skill.id === selectedSkillId) ?? null)
        : null;
      const attachmentRefs = getCompletedAttachmentRefs(attachments.chatAttachments);
      const selectedRuntime = selectedSkill?.runtime ?? selectedProfile?.runtime ?? null;
      const agentFields = agentOverrideFields(selectedProfile, selectedSkill);
      const requiresTaskSubmission = attachmentRefs.length > 0;
      // A chat with explicit resource overrides goes through submitTask so the backend can
      // honor them; Instant cannot carry resource requirements.
      const useInstantSession =
        selectedRuntime === 'cf-container' && !requiresTaskSubmission && !hasResources;

      let start: NewChatStart;
      if (useInstantSession) {
        const result = await startInstantChatSession(projectId, {
          message: trimmed,
          agentProfileId: submitProfileId,
          skillId: selectedSkillId ?? undefined,
          parentTaskId: pendingDerived?.parentTaskId || undefined,
          ...agentFields,
        });
        start = {
          kind: 'instant',
          sessionId: result.sessionId,
          message: trimmed,
          profileId: submitProfileId,
        };
      } else {
        if (selectedRuntime !== 'cf-container' && computeKnownAbsent) {
          setSubmitError(
            'Cloud credentials required. Connect a cloud provider in Settings, or ask your admin to add a platform cloud credential.'
          );
          return null;
        }
        const baseRequest = buildBaseSubmitRequest({
          message: trimmed,
          agentProfileId: submitProfileId,
          skillId: selectedSkillId,
          selectedAgentType,
          selectedResourceRequirements: toResourceRequirements(taskResourceReqs),
          selectedWorkspaceProfile,
          selectedDevcontainerConfigName,
          selectedTaskMode,
          pendingDerived,
        });
        const result = await submitTask(
          projectId,
          withAttachmentRefs({ ...baseRequest, ...agentFields }, attachmentRefs)
        );
        start = {
          kind: 'task',
          sessionId: result.sessionId,
          taskId: result.taskId,
          branchName: result.branchName,
          message: trimmed,
          profileId: submitProfileId,
        };
      }
      setMessage('');
      attachments.clearAttachments();
      // Per-chat overrides belong to the chat just started.
      resetComposerOverrides();
      void refreshProfilePicker();
      return start;
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to start task');
      return null;
    } finally {
      setSubmitting(false);
    }
  };

  return {
    projectId,
    message,
    setMessage,
    submitting,
    submitError,
    setSubmitError,
    startNewChat,
    configuredAgents,
    selectedAgentType,
    setSelectedAgentType,
    agentProfiles,
    selectedProfileId,
    profileChoice,
    skills,
    selectedSkillId,
    setSelectedSkillId,
    attachments,
    hasCloudCredentials,
    hasUserCloudCredentials,
    selectedWorkspaceProfile,
    setSelectedWorkspaceProfile,
    selectedDevcontainerConfigName,
    setSelectedDevcontainerConfigName,
    selectedTaskMode,
    handleTaskModeChange,
    overrides,
    transcribeApiUrl,
  };
}

export type NewChatComposer = ReturnType<typeof useNewChatComposer>;
