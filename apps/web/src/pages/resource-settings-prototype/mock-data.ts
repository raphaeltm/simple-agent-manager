export type ResourcePresetId =
  | 'conversation'
  | 'light'
  | 'standard'
  | 'heavy'
  | 'exclusive'
  | 'custom';

export interface ResourcePreset {
  id: ResourcePresetId;
  label: string;
  shortLabel: string;
  description: string;
  cpu: string;
  memory: string;
  disk: string;
  exclusive: boolean;
  placement: string;
}

export const resourcePresets: ResourcePreset[] = [
  {
    id: 'conversation',
    label: 'Conversational',
    shortLabel: 'Chat',
    description: 'Lightweight chat, planning, and agent coordination.',
    cpu: '0.2',
    memory: '512 MB',
    disk: '2 GB',
    exclusive: false,
    placement: 'Shares same-user nodes with other lightweight sessions',
  },
  {
    id: 'light',
    label: 'Light coding',
    shortLabel: 'Light',
    description: 'Small edits, repo inspection, docs, and simple CLI work.',
    cpu: '0.5',
    memory: '1 GB',
    disk: '5 GB',
    exclusive: false,
    placement: 'Fits on small nodes after system reserve',
  },
  {
    id: 'standard',
    label: 'Standard coding',
    shortLabel: 'Standard',
    description: 'Normal implementation work with a full workspace.',
    cpu: '2',
    memory: '4 GB',
    disk: '20 GB',
    exclusive: false,
    placement: 'Uses the smallest node with enough remaining reservation',
  },
  {
    id: 'heavy',
    label: 'Heavy build/test',
    shortLabel: 'Heavy',
    description: 'Devcontainer-heavy builds, e2e tests, and large installs.',
    cpu: '4',
    memory: '8 GB',
    disk: '40 GB',
    exclusive: false,
    placement: 'Usually needs a medium or larger node',
  },
  {
    id: 'exclusive',
    label: 'Exclusive node',
    shortLabel: 'Solo',
    description: 'Avoid co-tenancy for risky, large, or noisy work.',
    cpu: 'node',
    memory: 'node',
    disk: 'node',
    exclusive: true,
    placement: 'Requires an empty same-user node',
  },
];

export const touchpoints = [
  {
    id: 'start',
    title: 'Start',
    label: 'New chat',
    summary: 'One-off override before a session or task starts.',
  },
  {
    id: 'profile',
    title: 'Profile',
    label: 'Agent profile',
    summary: 'Reusable defaults for user-created profiles.',
  },
  {
    id: 'project',
    title: 'Project',
    label: 'Project defaults',
    summary: 'Repo-specific defaults for chat and full workspaces.',
  },
  {
    id: 'trigger',
    title: 'Trigger',
    label: 'Scheduled work',
    summary: 'Explicit resources for unattended recurring work.',
  },
  {
    id: 'admin',
    title: 'Admin',
    label: 'Placement math',
    summary: 'Debug view for capacity, reserve, and rejection reasons.',
  },
];

export const nodeMath = {
  nodeName: 'node-fsn1-medium-7d2c',
  capacity: '4 vCPU / 8 GB',
  reserve: '0.5 vCPU / 1.5 GB',
  existing: '0.7 vCPU / 1.5 GB',
  incoming: '2 vCPU / 4 GB',
  remaining: '0.8 vCPU / 1 GB',
  rejections: [
    { node: 'node-small-01', reason: 'insufficient memory after VM agent reserve' },
    { node: 'node-warm-03', reason: 'exclusive reservation already active' },
    { node: 'node-large-02', reason: 'different user; isolation boundary' },
  ],
};
