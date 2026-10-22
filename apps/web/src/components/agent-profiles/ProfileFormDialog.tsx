import type {
  AgentEffort,
  AgentProfile,
  AgentProfileRuntime,
  CreateAgentProfileRequest,
  GitHubCliPolicy,
  UpdateAgentProfileRequest,
} from '@simple-agent-manager/shared';
import {
  AGENT_CATALOG,
  DEFAULT_AGENT_EFFORT,
  DEFAULT_GITHUB_CLI_POLICY,
  getSupportedEffortsForAgent,
  isAgentEffortSupported,
} from '@simple-agent-manager/shared';
import { Button, Dialog, Input, Textarea } from '@simple-agent-manager/ui';
import { type FC, useEffect, useRef, useState } from 'react';

import { AgentModelAccessField } from '../agent-models/AgentModelAccessField';
import { ModelSelect } from '../ModelSelect';
import {
  deserializeResourceRequirements,
  EMPTY_RESOURCE_STATE,
  hasValidationErrors,
  type ResourceRequirementsFormState,
  type ResourceValidationErrors,
  serializeResourceRequirements,
  validateResourceState,
} from '../resource-requirements';
import { GitHubCliPolicyFields } from './GitHubCliPolicyFields';
import { DEFAULT_AGENT_TYPE, EFFORT_LABELS, PERMISSION_MODES } from './profile-form-options';
import {
  agentSettingsSummary,
  executionSummary,
  infraSummary,
  policySummary,
} from './profile-form-summaries';
import { Section, SelectField } from './ProfileFormPrimitives';
import { ProfileInfrastructureFields } from './ProfileInfrastructureFields';
import { ProfileRuntimeSection } from './ProfileRuntimeSection';

interface ProfileFormDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** If provided, the form is in edit mode. Otherwise create mode. */
  profile?: AgentProfile | null;
  onSave: (data: CreateAgentProfileRequest | UpdateAgentProfileRequest) => Promise<void>;
  /** Required for loading profile runtime assets in edit mode. */
  projectId: string;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const ProfileFormDialog: FC<ProfileFormDialogProps> = ({
  isOpen,
  onClose,
  profile,
  onSave,
  projectId,
}) => {
  const isEdit = !!profile;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [agentType, setAgentType] = useState<string>(DEFAULT_AGENT_TYPE);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<AgentEffort>(DEFAULT_AGENT_EFFORT);
  const [permissionMode, setPermissionMode] = useState('');
  const [systemPromptAppend, setSystemPromptAppend] = useState('');
  const [maxTurns, setMaxTurns] = useState('');
  const [timeoutMinutes, setTimeoutMinutes] = useState('');
  const [runtime, setRuntime] = useState('');
  const [vmSizeOverride, setVmSizeOverride] = useState('');
  const [resourceReqs, setResourceReqs] = useState<ResourceRequirementsFormState>({
    ...EMPTY_RESOURCE_STATE,
  });
  const [workspaceProfile, setWorkspaceProfile] = useState('');
  const [devcontainerConfigName, setDevcontainerConfigName] = useState('');
  const [taskMode, setTaskMode] = useState('');
  const [githubCliPolicy, setGithubCliPolicy] =
    useState<GitHubCliPolicy>(DEFAULT_GITHUB_CLI_POLICY);
  const [agentModels, setAgentModels] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Populate the form once per (open, profile id) — deliberately NOT keyed on the
   * `profile` object.
   *
   * `agentProfiles` is a TanStack cache entry shared by five surfaces, so the same
   * row arrives as a new object whenever it is refetched or written back by a
   * mutation elsewhere. Keying this effect on identity meant a background refresh
   * re-ran every `setX(profile.…)` below and silently reverted whatever the user had
   * typed. An edit form must load its row when it opens and then leave the user's
   * in-progress edits alone.
   *
   * `profile` is read through a ref so the populate effect does not take a
   * dependency on its identity. The sync effect is declared first, so it has already
   * committed the latest row by the time the populate effect runs.
   */
  const profileRef = useRef(profile);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);
  const profileId = profile?.id ?? null;

  useEffect(() => {
    const profile = profileRef.current;
    if (isOpen && profile) {
      const profileRuntime = profile.runtime ?? '';
      setName(profile.name);
      setDescription(profile.description ?? '');
      setAgentType(profile.agentType);
      setModel(profile.model ?? '');
      setEffort(profile.effort ?? DEFAULT_AGENT_EFFORT);
      setPermissionMode(profile.permissionMode ?? '');
      setSystemPromptAppend(profile.systemPromptAppend ?? '');
      setMaxTurns(profile.maxTurns != null ? String(profile.maxTurns) : '');
      setTimeoutMinutes(profile.timeoutMinutes != null ? String(profile.timeoutMinutes) : '');
      setRuntime(profileRuntime);
      setVmSizeOverride(profileRuntime === 'cf-container' ? '' : (profile.vmSizeOverride ?? ''));
      setResourceReqs(
        profileRuntime === 'cf-container'
          ? { ...EMPTY_RESOURCE_STATE }
          : deserializeResourceRequirements(profile.resourceRequirementsJson)
      );
      setWorkspaceProfile(
        profileRuntime === 'cf-container' ? 'lightweight' : (profile.workspaceProfile ?? '')
      );
      setDevcontainerConfigName(
        profileRuntime === 'cf-container' ? '' : (profile.devcontainerConfigName ?? '')
      );
      setTaskMode(profileRuntime === 'cf-container' ? 'conversation' : (profile.taskMode ?? ''));
      setGithubCliPolicy(profile.githubCliPolicy ?? DEFAULT_GITHUB_CLI_POLICY);
      setAgentModels(profile.agentModels ?? null);
    } else if (isOpen) {
      setName('');
      setDescription('');
      setAgentType(DEFAULT_AGENT_TYPE);
      setModel('');
      setEffort(DEFAULT_AGENT_EFFORT);
      setPermissionMode('');
      setSystemPromptAppend('');
      setMaxTurns('');
      setTimeoutMinutes('');
      setRuntime('');
      setVmSizeOverride('');
      setResourceReqs({ ...EMPTY_RESOURCE_STATE });
      setWorkspaceProfile('');
      setDevcontainerConfigName('');
      setTaskMode('');
      setGithubCliPolicy(DEFAULT_GITHUB_CLI_POLICY);
      setAgentModels(null);
    }
    setError(null);
  }, [isOpen, profileId]);

  const effortOptions = getSupportedEffortsForAgent(agentType).map((value) => ({
    value,
    label: EFFORT_LABELS[value],
  }));

  const [resourceErrors, setResourceErrors] = useState<ResourceValidationErrors>({});

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Profile name is required');
      return;
    }

    const resErrors = validateResourceState(resourceReqs);
    setResourceErrors(resErrors);
    if (hasValidationErrors(resErrors)) {
      setError('Fix resource requirement errors before saving');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const data: CreateAgentProfileRequest = {
        name: trimmedName,
        description: description.trim() || null,
        agentType: agentType || DEFAULT_AGENT_TYPE,
        model: model.trim() || null,
        effort,
        permissionMode: permissionMode || null,
        systemPromptAppend: systemPromptAppend.trim() || null,
        maxTurns: maxTurns ? parseInt(maxTurns, 10) : null,
        timeoutMinutes: timeoutMinutes ? parseInt(timeoutMinutes, 10) : null,
        runtime: runtime ? (runtime as AgentProfileRuntime) : null,
        vmSizeOverride: vmSizeOverride || null,
        resourceRequirementsJson: serializeResourceRequirements(resourceReqs),
        workspaceProfile: workspaceProfile || null,
        devcontainerConfigName:
          workspaceProfile !== 'lightweight' ? devcontainerConfigName.trim() || null : null,
        taskMode: taskMode || null,
        githubCliPolicy: githubCliPolicy.mode === 'custom' ? githubCliPolicy : null,
        agentModels,
      };
      await onSave(data);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  const handleRuntimeChange = (value: string) => {
    setRuntime(value);
    if (value === 'cf-container') {
      setVmSizeOverride('');
      setResourceReqs({ ...EMPTY_RESOURCE_STATE });
      setWorkspaceProfile('lightweight');
      setDevcontainerConfigName('');
      setTaskMode('conversation');
    }
  };

  const handleResourceReqsChange = (next: ResourceRequirementsFormState) => {
    setResourceReqs(next);
    setResourceErrors({});
  };

  const isInstantRuntime = runtime === 'cf-container';

  return (
    <Dialog isOpen={isOpen} onClose={onClose} maxWidth="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        <h2 id="dialog-title" className="text-lg font-semibold text-fg-primary mb-4">
          {isEdit ? 'Edit Profile' : 'Create Agent Profile'}
        </h2>

        {error && (
          <div
            role="alert"
            className="py-2 px-3 mb-3 rounded-sm bg-danger-tint text-danger text-sm"
          >
            {error}
          </div>
        )}

        {/* Name & Description — always visible */}
        <div className="grid gap-3">
          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">
              Name <span className="text-danger">*</span>
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="e.g. Fast Implementer"
              disabled={saving}
            />
          </label>

          <label htmlFor="profile-description" className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Description</span>
            <Textarea
              id="profile-description"
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              placeholder="What this profile is for. Shown on new-chat cards."
              disabled={saving}
              rows={3}
            />
          </label>
        </div>

        {/* --- Accordion sections --- */}

        <Section
          title="Agent Settings"
          defaultOpen
          summary={agentSettingsSummary(agentType, model, effort, permissionMode, timeoutMinutes)}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Agent Type"
              value={agentType}
              onChange={(v) => {
                setAgentType(v);
                setModel('');
                setEffort((current) =>
                  isAgentEffortSupported(v, current) ? current : DEFAULT_AGENT_EFFORT
                );
              }}
              options={AGENT_CATALOG.map((a) => ({ value: a.id, label: a.name }))}
              disabled={saving}
            />

            <div className="grid gap-1.5">
              <label htmlFor="profile-model" className="text-sm text-fg-muted">
                Model
              </label>
              <ModelSelect
                id="profile-model"
                agentType={agentType}
                value={model}
                onChange={setModel}
                disabled={saving}
                placeholder="Select or type a model..."
              />
            </div>

            <SelectField
              label="Effort"
              value={effort}
              onChange={(v) => setEffort(v as AgentEffort)}
              options={effortOptions}
              disabled={saving}
            />

            <SelectField
              label="Permission Mode"
              value={permissionMode}
              onChange={setPermissionMode}
              options={PERMISSION_MODES}
              disabled={saving}
            />

            <label className="grid gap-1.5">
              <span className="text-sm text-fg-muted">Timeout (minutes)</span>
              <Input
                type="number"
                value={timeoutMinutes}
                onChange={(e) => setTimeoutMinutes(e.currentTarget.value)}
                placeholder="Default"
                disabled={saving}
              />
            </label>
          </div>
        </Section>

        <Section title="Platform Policy" summary={policySummary(githubCliPolicy)}>
          <GitHubCliPolicyFields policy={githubCliPolicy} onChange={setGithubCliPolicy} disabled={saving} />
        </Section>

        <Section title="Execution" summary={executionSummary(maxTurns, systemPromptAppend)}>
          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">Max Turns</span>
            <Input
              type="number"
              value={maxTurns}
              onChange={(e) => setMaxTurns(e.currentTarget.value)}
              placeholder="Default"
              disabled={saving}
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">System Prompt (append)</span>
            <textarea
              value={systemPromptAppend}
              onChange={(e) => setSystemPromptAppend(e.target.value)}
              placeholder="Additional instructions appended to the system prompt..."
              rows={3}
              disabled={saving}
              className="w-full rounded-md text-fg-primary py-2.5 px-3 resize-y"
            />
          </label>
        </Section>

        <Section
          title="Infrastructure"
          summary={infraSummary(vmSizeOverride, resourceReqs, workspaceProfile, taskMode, runtime)}
        >
          <ProfileInfrastructureFields
            runtime={runtime}
            onRuntimeChange={handleRuntimeChange}
            vmSizeOverride={vmSizeOverride}
            onClearLegacyVmSize={() => setVmSizeOverride('')}
            resourceReqs={resourceReqs}
            onResourceReqsChange={handleResourceReqsChange}
            resourceErrors={resourceErrors}
            workspaceProfile={workspaceProfile}
            onWorkspaceProfileChange={setWorkspaceProfile}
            devcontainerConfigName={devcontainerConfigName}
            onDevcontainerConfigNameChange={setDevcontainerConfigName}
            taskMode={taskMode}
            onTaskModeChange={setTaskMode}
            disabled={saving || isInstantRuntime}
          />
        </Section>

        <Section
          title="AI Models"
          summary={agentModels === null ? 'Inherit from project' : `${agentModels.length} custom`}
        >
          <AgentModelAccessField
            projectId={projectId}
            ownerLabel="profile"
            value={agentModels}
            onChange={setAgentModels}
            disabled={saving}
          />
        </Section>

        {/* Runtime Environment (edit mode only) */}
        {isEdit && profile && (
          <Section title="Runtime Environment" summary="Env vars and files">
            <ProfileRuntimeSection projectId={projectId} profileId={profile.id} />
          </Section>
        )}

        {/* Actions */}
        <div className="flex gap-2 mt-4 pt-3 border-t border-border-default justify-end">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving} loading={saving}>
            {isEdit ? 'Save Changes' : 'Create Profile'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};
