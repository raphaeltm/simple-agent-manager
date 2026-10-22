import type { AgentEffort, GitHubCliPermissionLevel, GitHubCliPolicy } from '@simple-agent-manager/shared';
import { AGENT_CATALOG, AGENT_PERMISSION_MODE_LABELS, DEFAULT_AGENT_EFFORT } from '@simple-agent-manager/shared';

import type { ResourceRequirementsFormState } from '../resource-requirements';
import { hasAnyResourceValue } from '../resource-requirements';
import { EFFORT_LABELS } from './profile-form-options';

export function agentSettingsSummary(
  agentType: string,
  model: string,
  effort: AgentEffort,
  permissionMode: string,
  timeoutMinutes: string
): string {
  const parts: string[] = [];
  const agentName = AGENT_CATALOG.find((a) => a.id === agentType)?.name ?? agentType;
  parts.push(agentName);
  if (model) {
    const short = model.length > 24 ? model.slice(0, 22) + '...' : model;
    parts.push(short);
  }
  if (effort !== DEFAULT_AGENT_EFFORT) {
    parts.push(`Effort: ${EFFORT_LABELS[effort]}`);
  }
  if (permissionMode) {
    parts.push(
      (AGENT_PERMISSION_MODE_LABELS as Record<string, string>)[permissionMode] ?? permissionMode
    );
  }
  if (timeoutMinutes) parts.push(`${timeoutMinutes}m`);
  return parts.join(' · ');
}

function permTag(label: string, level: GitHubCliPermissionLevel): string | null {
  if (level === 'none') return null;
  return `${label}:${level === 'write' ? 'rw' : 'r'}`;
}

export function policySummary(policy: GitHubCliPolicy): string {
  if (policy.mode === 'inherit') return 'Inherit installation permissions';
  const p = policy.permissions;
  const tags = [
    permTag('code', p.contents),
    permTag('PRs', p.pullRequests),
    permTag('issues', p.issues),
    permTag('actions', p.actions),
    permTag('pkg', p.packages),
  ].filter(Boolean);
  return `Custom: ${tags.join(', ')}`;
}

function joinOrDefault(parts: (string | false | null | undefined)[], sep = ', '): string {
  const filtered = parts.filter(Boolean) as string[];
  return filtered.length ? filtered.join(sep) : 'Defaults';
}

export function executionSummary(maxTurns: string, systemPromptAppend: string): string {
  return joinOrDefault([
    maxTurns && `${maxTurns} turns`,
    systemPromptAppend.trim() && 'custom prompt',
  ]);
}

function runtimeSummary(runtime: string): string | false {
  if (runtime === 'cf-container') return 'Instant container';
  if (runtime === 'vm') return 'Cloud VM';
  return false;
}

export function infraSummary(
  vmSize: string,
  resourceReqs: ResourceRequirementsFormState,
  workspaceProfile: string,
  taskMode: string,
  runtime: string
): string {
  let resourcePart = '';
  if (hasAnyResourceValue(resourceReqs)) {
    const parts: string[] = [];
    if (resourceReqs.minVcpu) parts.push(`${resourceReqs.minVcpu} vCPU`);
    if (resourceReqs.minMemoryGb) parts.push(`${resourceReqs.minMemoryGb} GB`);
    resourcePart = parts.join(', ') || 'Custom resources';
  } else if (vmSize) {
    resourcePart = `${vmSize} (legacy)`;
  }
  return joinOrDefault(
    [runtimeSummary(runtime), resourcePart, workspaceProfile, taskMode],
    ' · '
  );
}
