/**
 * What one row of the profile list says about a profile: the knobs it sets and
 * the resources it asks the scheduler for. Pure, so the list and its tests read
 * the same strings.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { AGENT_PERMISSION_MODE_LABELS, DEFAULT_AGENT_EFFORT } from '@simple-agent-manager/shared';

import {
  deserializeResourceRequirements,
  formatLegacyVmSize,
} from '../resource-requirements';
import { EFFORT_LABELS } from './profile-form-options';

const GITHUB_PERMISSION_NAMES: Record<string, string> = {
  contents: 'code',
  pullRequests: 'PRs',
  issues: 'issues',
  actions: 'actions',
  packages: 'packages',
};

function githubCliPolicySummary(profile: AgentProfile): string | null {
  const policy = profile.githubCliPolicy;
  if (policy?.mode !== 'custom') return null;
  const denied = Object.entries(policy.permissions)
    .filter(([, level]) => level === 'none')
    .map(([name]) => GITHUB_PERMISSION_NAMES[name] ?? name);
  return denied.length > 0
    ? `GitHub CLI: no ${denied.join(', ')}`
    : 'GitHub CLI: repository scoped';
}

const TASK_MODE_LABELS: Record<string, string> = { task: 'Task', conversation: 'Chat' };

/** The settings worth reading at a glance, after the model: effort, mode, approvals. */
export function profileFacts(profile: AgentProfile): string[] {
  const facts: string[] = [];
  if (profile.effort !== DEFAULT_AGENT_EFFORT) facts.push(`${EFFORT_LABELS[profile.effort]} effort`);
  if (profile.taskMode) facts.push(TASK_MODE_LABELS[profile.taskMode] ?? profile.taskMode);
  if (profile.permissionMode) {
    facts.push(
      (AGENT_PERMISSION_MODE_LABELS as Record<string, string>)[profile.permissionMode] ??
        profile.permissionMode
    );
  }
  const github = githubCliPolicySummary(profile);
  if (github) facts.push(github);
  return facts;
}

export type ProfileResources =
  | { kind: 'instant' }
  | { kind: 'request'; text: string; detail: string; exclusiveNode: boolean }
  | { kind: 'legacy'; text: string }
  | { kind: 'default' };

/**
 * The profile's own resource request. Explicit requirements win over the legacy
 * VM size; neither means the project/installation default applies. Instant
 * profiles run in a container and request no VM capacity.
 */
export function profileResources(profile: AgentProfile): ProfileResources {
  if (profile.runtime === 'cf-container') return { kind: 'instant' };
  const stored = deserializeResourceRequirements(profile.resourceRequirementsJson);
  if (!stored.storedJsonError && (stored.minVcpu || stored.minMemoryGb || stored.minDiskGb)) {
    const short = [
      stored.minVcpu && `${stored.minVcpu} vCPU`,
      stored.minMemoryGb && `${stored.minMemoryGb} GB`,
    ].filter(Boolean) as string[];
    const detail = [...short, stored.minDiskGb && `${stored.minDiskGb} GB disk`].filter(
      Boolean
    ) as string[];
    return {
      kind: 'request',
      text: short.length > 0 ? short.join(' · ') : `${stored.minDiskGb} GB disk`,
      detail: `Requests at least ${detail.join(', ')}`,
      exclusiveNode: stored.exclusiveNode === true,
    };
  }
  if (stored.exclusiveNode === true) {
    return {
      kind: 'request',
      text: 'Default size',
      detail: 'Requests a node of its own',
      exclusiveNode: true,
    };
  }
  const legacy = formatLegacyVmSize(profile.vmSizeOverride);
  if (legacy) return { kind: 'legacy', text: `${legacy} VM` };
  return { kind: 'default' };
}
