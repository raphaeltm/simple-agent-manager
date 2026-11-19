import { Input } from '@simple-agent-manager/ui';

import {
  type ResourceRequirementsFormState,
  ResourceRequirementsInput,
  type ResourceValidationErrors,
} from '../resource-requirements';
import { RUNTIMES, TASK_MODES, WORKSPACE_PROFILES } from './profile-form-options';
import { SelectField } from './ProfileFormPrimitives';

interface ProfileInfrastructureFieldsProps {
  runtime: string;
  onRuntimeChange: (value: string) => void;
  vmSizeOverride: string;
  onClearLegacyVmSize: () => void;
  resourceReqs: ResourceRequirementsFormState;
  onResourceReqsChange: (next: ResourceRequirementsFormState) => void;
  resourceErrors: ResourceValidationErrors;
  workspaceProfile: string;
  onWorkspaceProfileChange: (value: string) => void;
  devcontainerConfigName: string;
  onDevcontainerConfigNameChange: (value: string) => void;
  taskMode: string;
  onTaskModeChange: (value: string) => void;
  disabled?: boolean;
}

/** The "Infrastructure" section's fields, extracted from `ProfileFormDialog` to keep it under the file-size ceiling. */
export function ProfileInfrastructureFields({
  runtime,
  onRuntimeChange,
  vmSizeOverride,
  onClearLegacyVmSize,
  resourceReqs,
  onResourceReqsChange,
  resourceErrors,
  workspaceProfile,
  onWorkspaceProfileChange,
  devcontainerConfigName,
  onDevcontainerConfigNameChange,
  taskMode,
  onTaskModeChange,
  disabled,
}: ProfileInfrastructureFieldsProps) {
  const isInstantRuntime = runtime === 'cf-container';

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <SelectField
        label="Runtime"
        value={runtime}
        onChange={onRuntimeChange}
        options={RUNTIMES}
        disabled={disabled}
      />

      {!isInstantRuntime && (
        <div className="sm:col-span-2">
          <ResourceRequirementsInput
            value={resourceReqs}
            onChange={onResourceReqsChange}
            onClearLegacy={onClearLegacyVmSize}
            disabled={disabled}
            legacyVmSize={vmSizeOverride}
            inheritLabel="default"
            errors={resourceErrors}
          />
        </div>
      )}

      <SelectField
        label="Workspace Profile"
        value={workspaceProfile}
        onChange={onWorkspaceProfileChange}
        options={WORKSPACE_PROFILES}
        disabled={disabled || isInstantRuntime}
      />

      {!isInstantRuntime && workspaceProfile !== 'lightweight' && (
        <label className="grid gap-1.5">
          <span className="text-sm text-fg-muted">Devcontainer Config</span>
          <Input
            value={devcontainerConfigName}
            onChange={(e) => onDevcontainerConfigNameChange(e.target.value)}
            disabled={disabled}
            placeholder="Auto-detect"
          />
        </label>
      )}

      <SelectField
        label="Task Mode"
        value={taskMode}
        onChange={onTaskModeChange}
        options={TASK_MODES}
        disabled={disabled || isInstantRuntime}
      />
    </div>
  );
}
