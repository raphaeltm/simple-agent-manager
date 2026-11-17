import type {
  AgentInfo,
  AgentProfileRuntime,
  CreateAgentProfileRequest,
  TaskMode,
  UpdateAgentProfileRequest,
  VMSize,
} from '@simple-agent-manager/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { selectProfileId } from '../../components/project-chat/profile-picker/model';
import {
  EMPTY_RESOURCE_STATE,
  type ResourceRequirementsFormState,
  serializeResourceRequirements,
} from '../../components/resource-requirements';
import { useAgentProfiles } from '../../hooks/useAgentProfiles';
import { useProfilePicker } from '../../hooks/useProfilePicker';
import { instantRuntimeEnabledQueryOptions } from '../../lib/query-options';
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
  /** Whether Instant can run on this installation; the runtime step offers it only then. */
  instantAvailable: boolean;
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
  instantAvailable: true,
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
    loading: profilesLoading,
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
  const queryClient = useQueryClient();
  // Whether this installation can run Instant (Cloudflare Containers). Unknown counts as
  // available in the wizard, as before; the one-click profile below waits for the answer.
  const instantQuery = useQuery({
    ...instantRuntimeEnabledQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });
  const instantAvailable = instantQuery.data !== false;

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
      instantAvailable,
    });
  }, [configuredAgents, instantAvailable, selectedAgentType]);

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

  /**
   * One click on the no-profiles gate when the project has exactly one configured agent: create
   * the single chat profile the wizard would have suggested. Never runs on its own (policy:
   * fresh installs do not get seeded profiles). Instant only where this installation can run
   * it, read at click time so a cold cache cannot pick the wrong runtime.
   */
  const createDefaultChatProfile = useCallback(async () => {
    const soleAgent = configuredAgents.length === 1 ? configuredAgents[0] : null;
    if (!soleAgent) return null;
    const instantEnabled = await queryClient.fetchQuery(
      instantRuntimeEnabledQueryOptions(queryScope)
    );
    const runtime = resolveWizardRuntime('conversation', null, instantEnabled);
    return createProfile({
      name: suggestProfileName(soleAgent.id, 'conversation'),
      description: 'Chat and explore with a lightweight workspace',
      agentType: soleAgent.id,
      runtime,
      workspaceProfile: resolveWizardWorkspaceProfile(runtime, 'conversation'),
      taskMode: resolveWizardTaskMode(runtime, 'conversation'),
    });
  }, [configuredAgents, createProfile, queryClient, queryScope, suggestProfileName]);

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
    const runtime = resolveWizardRuntime(workType, profileWizard.runtime, instantAvailable);
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
    instantAvailable,
    profileWizard.profileName,
    profileWizard.runtime,
    profileWizard.selectedAgentType,
    profileWizard.resourceReqs,
    profileWizard.workType,
  ]);

  return {
    agentProfiles,
    /** The first read of the project's profiles is still in flight (no list yet). */
    profilesLoading,
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
    createDefaultChatProfile,
    suggestProfileName,
  };
}
