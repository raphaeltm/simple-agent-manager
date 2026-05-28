export interface MockAgent {
  id: string;
  name: string;
  description: string;
  icon: string;
}

export interface MockProfile {
  id: string;
  name: string;
  agentType: string;
  vmSize: 'small' | 'medium' | 'large';
  workspaceProfile: 'full' | 'lightweight';
  taskMode: 'task' | 'conversation';
  description: string | null;
}

export interface MockVmSize {
  key: 'small' | 'medium' | 'large';
  label: string;
  description: string;
  specs: string;
  pricePerHour: string;
}

export const SINGLE_AGENT: MockAgent[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic\'s autonomous coding agent',
    icon: 'C',
  },
];

export const MULTIPLE_AGENTS: MockAgent[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic\'s autonomous coding agent. Great for complex multi-file changes, refactoring, and debugging.',
    icon: 'C',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    description: 'OpenAI\'s lightweight coding assistant. Fast for quick edits and simple tasks.',
    icon: 'O',
  },
  {
    id: 'aider',
    name: 'Aider',
    description: 'Open-source AI pair programmer. Flexible model support, git-native workflow.',
    icon: 'A',
  },
];

export const VM_SIZES: MockVmSize[] = [
  {
    key: 'small',
    label: 'Small',
    description: 'Quick questions, light edits',
    specs: '2 vCPU, 4 GB RAM',
    pricePerHour: '~$0.007/hr',
  },
  {
    key: 'medium',
    label: 'Medium',
    description: 'Most coding tasks',
    specs: '4 vCPU, 8 GB RAM',
    pricePerHour: '~$0.014/hr',
  },
  {
    key: 'large',
    label: 'Large',
    description: 'Heavy builds, monorepos',
    specs: '8 vCPU, 16 GB RAM',
    pricePerHour: '~$0.027/hr',
  },
];

export const EXISTING_PROFILES: MockProfile[] = [
  {
    id: 'p1',
    name: 'Implementer',
    agentType: 'claude-code',
    vmSize: 'medium',
    workspaceProfile: 'full',
    taskMode: 'task',
    description: 'Write code, open PRs',
  },
  {
    id: 'p2',
    name: 'Quick Chat',
    agentType: 'claude-code',
    vmSize: 'small',
    workspaceProfile: 'lightweight',
    taskMode: 'conversation',
    description: 'Explore code, ask questions',
  },
];
