import type { AgentEffort } from '@simple-agent-manager/shared';
import {
  AGENT_CATALOG,
  AGENT_PERMISSION_MODE_LABELS,
  VALID_PERMISSION_MODES,
} from '@simple-agent-manager/shared';

/** Default agent type derived from the catalog — avoids hardcoding 'claude-code' */
const defaultAgentCatalogEntry = AGENT_CATALOG[0];
if (!defaultAgentCatalogEntry) {
  throw new Error(
    'ProfileFormDialog: AGENT_CATALOG is empty — cannot resolve a default agent type'
  );
}
export const DEFAULT_AGENT_TYPE = defaultAgentCatalogEntry.id;

export const PERMISSION_MODES = [
  { value: '', label: 'No override' },
  ...VALID_PERMISSION_MODES.map((mode) => ({
    value: mode,
    label: AGENT_PERMISSION_MODE_LABELS[mode] ?? mode,
  })),
];

export const EFFORT_LABELS: Record<AgentEffort, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export const RUNTIMES = [
  { value: '', label: 'Auto' },
  { value: 'cf-container', label: 'Instant container' },
  { value: 'vm', label: 'Cloud VM' },
] as const;

export const WORKSPACE_PROFILES = [
  { value: '', label: 'Default' },
  { value: 'full', label: 'Full' },
  { value: 'lightweight', label: 'Lightweight' },
] as const;

export const TASK_MODES = [
  { value: '', label: 'Default' },
  { value: 'task', label: 'Task' },
  { value: 'conversation', label: 'Conversation' },
] as const;

export const GITHUB_PERMISSION_OPTIONS = [
  { value: 'none', label: 'No access' },
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Read and write' },
] as const;

export const GITHUB_CONTENTS_OPTIONS = [
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Read and write' },
] as const;

export const GITHUB_PERMISSION_ROWS = [
  { key: 'contents', label: 'Code contents', options: GITHUB_CONTENTS_OPTIONS },
  { key: 'pullRequests', label: 'Pull requests', options: GITHUB_PERMISSION_OPTIONS },
  { key: 'issues', label: 'Issues', options: GITHUB_PERMISSION_OPTIONS },
  { key: 'actions', label: 'Actions', options: GITHUB_PERMISSION_OPTIONS },
  { key: 'packages', label: 'Packages', options: GITHUB_PERMISSION_OPTIONS },
] as const;
