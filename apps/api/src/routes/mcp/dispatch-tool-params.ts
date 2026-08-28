import type { AgentProfileRuntime, TaskMode, VMSize, WorkspaceProfile } from '@simple-agent-manager/shared';
import {
  DEVCONTAINER_CONFIG_NAME_MAX_LENGTH,
  DEVCONTAINER_CONFIG_NAME_REGEX,
  isValidAgentType,
} from '@simple-agent-manager/shared';

import { INVALID_PARAMS, jsonRpcError, type JsonRpcResponse } from './_helpers';
import { parseDispatchRuntime } from './dispatch-instant';

const VALID_TASK_MODES: TaskMode[] = ['task', 'conversation'];
const VALID_WORKSPACE_PROFILES: WorkspaceProfile[] = ['full', 'lightweight'];

interface DispatchTaskLimits {
  dispatchDescriptionMaxLength: number;
  dispatchMaxPriority: number;
  dispatchMaxReferences: number;
  dispatchMaxReferenceLength: number;
}

export interface ParsedDispatchTaskParams {
  description: string;
  vmSize?: VMSize;
  explicitRuntime?: AgentProfileRuntime;
  priority: number;
  references: string[];
  explicitBranch?: string;
  agentProfileId?: string;
  skillId?: string;
  explicitTaskMode?: TaskMode;
  explicitAgentType?: string;
  explicitWorkspaceProfile?: WorkspaceProfile;
  explicitDevcontainerConfigName?: string | null;
  explicitProvider?: string;
  explicitVmLocation?: string;
  explicitMissionId?: string;
}

export function parseDispatchTaskParams(
  requestId: string | number | null,
  params: Record<string, unknown>,
  limits: DispatchTaskLimits
): { parsed: ParsedDispatchTaskParams } | { error: JsonRpcResponse } {
  const description = typeof params.description === 'string' ? params.description.trim() : '';
  if (!description) {
    return {
      error: jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'description is required and must be a non-empty string'
      ),
    };
  }
  if (description.length > limits.dispatchDescriptionMaxLength) {
    return {
      error: jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `description exceeds maximum length of ${limits.dispatchDescriptionMaxLength} characters`
      ),
    };
  }

  let vmSize: VMSize | undefined;
  if (params.vmSize !== undefined) {
    if (
      typeof params.vmSize !== 'string' ||
      !['small', 'medium', 'large'].includes(params.vmSize)
    ) {
      return {
        error: jsonRpcError(requestId, INVALID_PARAMS, 'vmSize must be small, medium, or large'),
      };
    }
    vmSize = params.vmSize as VMSize;
  }

  let explicitRuntime: AgentProfileRuntime | undefined;
  if (params.runtime !== undefined) {
    explicitRuntime = parseDispatchRuntime(params.runtime);
    if (!explicitRuntime) {
      return {
        error: jsonRpcError(requestId, INVALID_PARAMS, 'runtime must be vm or cf-container'),
      };
    }
  }

  const priority =
    typeof params.priority === 'number'
      ? Math.min(Math.max(0, Math.round(params.priority)), limits.dispatchMaxPriority)
      : 0;
  const references = Array.isArray(params.references)
    ? params.references
        .filter((r): r is string => typeof r === 'string')
        .slice(0, limits.dispatchMaxReferences)
        .map((r) => r.slice(0, limits.dispatchMaxReferenceLength))
    : [];

  let explicitBranch: string | undefined;
  if (params.branch !== undefined) {
    if (typeof params.branch !== 'string' || params.branch.trim().length === 0) {
      return {
        error: jsonRpcError(requestId, INVALID_PARAMS, 'branch must be a non-empty string'),
      };
    }
    explicitBranch = params.branch.trim();
  }

  const agentProfileId =
    typeof params.agentProfileId === 'string' ? params.agentProfileId.trim() : undefined;
  if (params.agentProfileId !== undefined && !agentProfileId) {
    return {
      error: jsonRpcError(requestId, INVALID_PARAMS, 'agentProfileId must be a non-empty string'),
    };
  }

  const skillId = typeof params.skillId === 'string' ? params.skillId.trim() : undefined;
  if (params.skillId !== undefined && !skillId) {
    return {
      error: jsonRpcError(requestId, INVALID_PARAMS, 'skillId must be a non-empty string'),
    };
  }

  let explicitTaskMode: TaskMode | undefined;
  if (params.taskMode !== undefined) {
    if (
      typeof params.taskMode !== 'string' ||
      !VALID_TASK_MODES.includes(params.taskMode as TaskMode)
    ) {
      return {
        error: jsonRpcError(
          requestId,
          INVALID_PARAMS,
          `taskMode must be one of: ${VALID_TASK_MODES.join(', ')}`
        ),
      };
    }
    explicitTaskMode = params.taskMode as TaskMode;
  }

  let explicitAgentType: string | undefined;
  if (params.agentType !== undefined) {
    if (typeof params.agentType !== 'string' || !isValidAgentType(params.agentType)) {
      return {
        error: jsonRpcError(requestId, INVALID_PARAMS, `agentType is not a recognized agent type`),
      };
    }
    explicitAgentType = params.agentType;
  }

  let explicitWorkspaceProfile: WorkspaceProfile | undefined;
  if (params.workspaceProfile !== undefined) {
    if (
      typeof params.workspaceProfile !== 'string' ||
      !VALID_WORKSPACE_PROFILES.includes(params.workspaceProfile as WorkspaceProfile)
    ) {
      return {
        error: jsonRpcError(
          requestId,
          INVALID_PARAMS,
          `workspaceProfile must be one of: ${VALID_WORKSPACE_PROFILES.join(', ')}`
        ),
      };
    }
    explicitWorkspaceProfile = params.workspaceProfile as WorkspaceProfile;
  }

  let explicitDevcontainerConfigName: string | null | undefined;
  if (params.devcontainerConfigName !== undefined) {
    if (params.devcontainerConfigName === null) {
      explicitDevcontainerConfigName = null;
    } else if (
      typeof params.devcontainerConfigName !== 'string' ||
      !DEVCONTAINER_CONFIG_NAME_REGEX.test(params.devcontainerConfigName)
    ) {
      return {
        error: jsonRpcError(
          requestId,
          INVALID_PARAMS,
          'devcontainerConfigName must be alphanumeric with hyphens/underscores'
        ),
      };
    } else if (params.devcontainerConfigName.length > DEVCONTAINER_CONFIG_NAME_MAX_LENGTH) {
      return {
        error: jsonRpcError(
          requestId,
          INVALID_PARAMS,
          `devcontainerConfigName must be at most ${DEVCONTAINER_CONFIG_NAME_MAX_LENGTH} characters`
        ),
      };
    } else {
      explicitDevcontainerConfigName = params.devcontainerConfigName;
    }
  }

  let explicitProvider: string | undefined;
  if (params.provider !== undefined) {
    if (typeof params.provider !== 'string') {
      return { error: jsonRpcError(requestId, INVALID_PARAMS, 'provider must be a string') };
    }
    explicitProvider = params.provider;
  }

  let explicitVmLocation: string | undefined;
  if (params.vmLocation !== undefined) {
    if (typeof params.vmLocation !== 'string' || params.vmLocation.trim().length === 0) {
      return {
        error: jsonRpcError(requestId, INVALID_PARAMS, 'vmLocation must be a non-empty string'),
      };
    }
    explicitVmLocation = params.vmLocation.trim();
  }

  const explicitMissionId =
    typeof params.missionId === 'string' ? params.missionId.trim() : undefined;

  return {
    parsed: {
      description,
      vmSize,
      explicitRuntime,
      priority,
      references,
      explicitBranch,
      agentProfileId,
      skillId,
      explicitTaskMode,
      explicitAgentType,
      explicitWorkspaceProfile,
      explicitDevcontainerConfigName,
      explicitProvider,
      explicitVmLocation,
      explicitMissionId,
    },
  };
}
