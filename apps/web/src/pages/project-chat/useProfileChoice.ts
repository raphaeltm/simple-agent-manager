import type {
  AgentInfo,
  AgentProfileRuntime,
  CreateAgentProfileRequest,
  TaskMode,
  UpdateAgentProfileRequest,
  VMSize,
} from '@simple-agent-manager/shared';
import { useCallback, useEffect, useState } from 'react';

import { selectProfileId } from '../../components/project-chat/profile-picker/model';
import {
  EMPTY_RESOURCE_STATE,
  type ResourceRequirementsFormState,
  serializeResourceRequirements,
} from '../../components/resource-requirements';
import { useAgentProfiles } from '../../hooks/useAgentProfiles';
import { useProfilePicker } from '../../hooks/useProfilePicker';
import {
  resolveWizardRuntime,
  resolveWizardTaskMode,
  resolveWizardWorkspaceProfile,
} from './profileWizardHelpers';

export type ProfileWizardStep = 'agent' | 'work-type' | 'runtime' | 'resources' | 'name';

export interface ProfileWizardState {
  open: boolean;
  step: ProfileWizardStep;
  selectedAgentType: string | null;
  workType: TaskMode | null;
  runtime: AgentProfileRuntime | null;
  vmSize: VMSize | null;
  resourceReqs: ResourceRequirementsFormState;
  profileName: string;
  saving: boolean;
  error: string | null;
}

/** Where the picker sheet opens: above its trigger, or centered when anchor is null. */
export interface ProfileSheetState {
  open: boolean;
  anchor: DOMRect | null;
}

const CLOSED_WIZARD: ProfileWizardState = {
  open: false,
  step: 'agent',
  selectedAgentType: null,
  workType: null,
  runtime: null,
  vmSize: null,
  resourceReqs: { ...EMPTY_RESOURCE_STATE },
  profileName: '',
  saving: false,
  error: null,
};

/**
 * Which profile a new chat starts with: the project's profiles, the person's picker state
 * (recent + hidden), the pre-selection, the shared picker sheet and the inline
 * create-profile wizard. Extracted from useProjectChatState.
 */
export function useProfileChoice({
  projectId,
  queryScope,
  configuredAgents,
  selectedAgentType,
}: Readonly<{
  projectId: string;
  queryScope: string;
  configuredAgents: AgentInfo[];
  selectedAgentType: string | null;
}>) {
  const {
    profiles: agentProfiles,
    createProfile: createProfileMutation,
    updateProfile,
  } = useAgentProfiles(projectId, queryScope);
  const profilePicker = useProfilePicker(projectId, queryScope);
  const { picker } = profilePicker;
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [profileSheet, setProfileSheet] = useState<ProfileSheetState>({
    open: false,
    anchor: null,
  });
  const [profileWizard, setProfileWizard] = useState<ProfileWizardState>(CLOSED_WIZARD);

  // Fill in a default once profiles and picker state are known. Guarded on the current
  // selection, so it never overrides a profile the person picked
  // (.claude/rules/06-technical-patterns.md, interaction-effect analysis).
  useEffect(() => {
    setSelectedProfileId((current) => selectProfileId(current, agentProfiles, picker));
  }, [agentProfiles, picker]);

  const openProfileSheet = useCallback((anchor: DOMRect | null) => {
    setProfileSheet({ open: true, anchor });
  }, []);
  const closeProfileSheet = useCallback(() => {
    setProfileSheet((current) => ({ ...current, open: false }));
  }, []);

  const handleUpdateProfile = useCallback(
    async (profileId: string, data: UpdateAgentProfileRequest) => {
      await updateProfile(profileId, data);
    },
    [updateProfile]
  );

  const suggestProfileName = useCallback(
    (agentType: string | null, workType: TaskMode | null) => {
      const agent = configuredAgents.find((candidate) => candidate.id === agentType);
      const agentName = agent?.name ?? 'Agent';
      return workType === 'task' ? `${agentName} Tasks` : `${agentName} Chat`;
    },
    [configuredAgents]
  );

  const openProfileWizard = useCallback(() => {
    const soleAgent = configuredAgents.length === 1 ? configuredAgents[0] : null;
    const initialAgentType = soleAgent?.id ?? selectedAgentType ?? configuredAgents[0]?.id ?? null;
    setProfileWizard({
      ...CLOSED_WIZARD,
      resourceReqs: { ...EMPTY_RESOURCE_STATE },
      open: true,
      step: soleAgent ? 'work-type' : 'agent',
      selectedAgentType: initialAgentType,
    });
  }, [configuredAgents, selectedAgentType]);

  const closeProfileWizard = useCallback(() => {
    setProfileWizard((current) => ({ ...current, open: false, saving: false, error: null }));
  }, []);

  const updateProfileWizard = useCallback((patch: Partial<ProfileWizardState>) => {
    setProfileWizard((current) => ({ ...current, ...patch, error: null }));
  }, []);

  const createProfile = useCallback(
    async (data: CreateAgentProfileRequest) => {
      // The mutation invalidates the shared `agentProfiles` entry, so the new profile
      // reaches every consumer (profiles page, task forms, trigger form).
      const profile = await createProfileMutation(data);
      setSelectedProfileId(profile.id);
      return profile;
    },
    [createProfileMutation]
  );

  const createProfileFromWizard = useCallback(async () => {
    const name = profileWizard.profileName.trim();
    if (!name) {
      setProfileWizard((current) => ({ ...current, error: 'Profile name is required' }));
      return null;
    }
    if (agentProfiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
      setProfileWizard((current) => ({ ...current, error: `Profile "${name}" already exists` }));
      return null;
    }
    const agentType = profileWizard.selectedAgentType ?? configuredAgents[0]?.id;
    if (!agentType) {
      setProfileWizard((current) => ({
        ...current,
        error: 'Choose an agent before creating a profile',
      }));
      return null;
    }
    const workType = profileWizard.workType ?? 'conversation';
    const runtime = resolveWizardRuntime(workType, profileWizard.runtime);
    setProfileWizard((current) => ({ ...current, saving: true, error: null }));
    try {
      const resourceJson =
        runtime === 'cf-container'
          ? null
          : serializeResourceRequirements(profileWizard.resourceReqs);
      const profile = await createProfile({
        name,
        description:
          workType === 'task'
            ? 'Write code and open pull requests'
            : 'Chat and explore with a lightweight workspace',
        agentType,
        runtime,
        resourceRequirementsJson: resourceJson,
        workspaceProfile: resolveWizardWorkspaceProfile(runtime, workType),
        taskMode: resolveWizardTaskMode(runtime, workType),
      });
      setProfileWizard((current) => ({ ...current, open: false, saving: false, error: null }));
      return profile;
    } catch (err) {
      setProfileWizard((current) => ({
        ...current,
        saving: false,
        error: err instanceof Error ? err.message : 'Failed to create profile',
      }));
      return null;
    }
  }, [
    agentProfiles,
    configuredAgents,
    createProfile,
    profileWizard.profileName,
    profileWizard.runtime,
    profileWizard.selectedAgentType,
    profileWizard.resourceReqs,
    profileWizard.workType,
  ]);

  return {
    agentProfiles,
    selectedProfileId,
    setSelectedProfileId,
    profilePicker,
    profileSheet,
    openProfileSheet,
    closeProfileSheet,
    handleUpdateProfile,
    profileWizard,
    openProfileWizard,
    closeProfileWizard,
    updateProfileWizard,
    createProfileFromWizard,
    suggestProfileName,
  };
}
