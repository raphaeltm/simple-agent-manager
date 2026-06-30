// Stress-test mock data for the title-led SessionHeader prototype.
// Intentionally comical amounts of data to find where the layout breaks.

export interface MockPort {
  port: number;
  address: string;
  label: string;
  url: string;
}

export interface MockScenario {
  id: string;
  /** Short human label for the scenario picker. */
  name: string;
  title: string;
  /** Initial prompt that started the session (first user message). */
  initialPrompt: string;
  lineageText?: string;
  profile: 'lightweight' | 'full' | 'recovery';
  status: 'active' | 'idle' | 'stopped';
  ports: MockPort[];
  workspaceName: string;
  vmSize: string;
  nodeName: string;
  provider: string;
  branch?: string;
  agentType: string;
  taskMode: 'task' | 'conversation';
  agentProfileHint?: string;
}

function makePorts(count: number): MockPort[] {
  const labels = [
    'Vite Dev', 'Django', 'Next.js', 'Storybook', 'Postgres', 'Redis', 'Mailhog',
    'API', 'Worker', 'Webpack', 'Jest', 'Playwright', 'Grafana', 'Prometheus',
    'Jupyter', 'Flask', 'Rails', 'Sidekiq', 'Adminer', 'pgweb',
  ];
  return Array.from({ length: count }, (_, i) => {
    const port = 3000 + i;
    return {
      port,
      address: i % 4 === 0 ? '127.0.0.1' : '0.0.0.0',
      label: labels[i % labels.length],
      url: `https://ws-abc123def456--${port}.sammy.party`,
    };
  });
}

const LONG_PROMPT = `I want you to refactor the entire authentication subsystem so that we move away from the legacy cookie-based session middleware and adopt a token-rotation model with per-project credential overrides. While you're in there, please also audit every callback route to make sure VM agent callbacks aren't leaking into the session-auth wildcard, add regression tests for the inactive-scoped-row-blocks-fallback invariant, update the self-hosting docs, and make sure the staging deploy is green before you even think about merging. Oh and the friend who was testing yesterday said the header title was unreadable on his phone, so fix that too. Thanks!`;

export const SCENARIOS: MockScenario[] = [
  {
    id: 'extreme',
    name: '50 ports + huge title',
    title:
      'Refactor the entire authentication subsystem to use token rotation with per-project credential overrides and fix the unreadable mobile header title while you are at it',
    initialPrompt: LONG_PROMPT,
    lineageText: '⑂ forked from "Investigate flaky credential resolution tests on staging"',
    profile: 'lightweight',
    status: 'active',
    ports: makePorts(50),
    workspaceName: 'auth-subsystem-refactor-with-a-very-long-workspace-display-name',
    vmSize: 'cpx41',
    nodeName: 'node-hetzner-fsn1-pool-warm-7f3a9c2b1e',
    provider: 'hetzner',
    branch: 'feature/token-rotation-per-project-credential-overrides-and-callback-audit',
    agentType: 'claude-code',
    taskMode: 'task',
    agentProfileHint: 'Senior Backend Engineer (Cloudflare + Auth specialist profile)',
  },
  {
    id: 'unbreakable',
    name: 'No-space mega word',
    title:
      'Supercalifragilisticexpialidocious_refactor_the_authentication_subsystem_with_no_spaces_at_all_to_test_truncation_versus_wrapping_behavior_in_the_header',
    initialPrompt:
      'Fix this:\npnpm_quality_migration_safety_check_is_failing_because_of_a_very_long_unbreakable_identifier_that_will_not_wrap',
    profile: 'recovery',
    status: 'idle',
    ports: makePorts(7),
    workspaceName: 'recovery-container-fallback',
    vmSize: 'cpx21',
    nodeName: 'node-scaleway-par1-0a1b2c3d',
    provider: 'scaleway',
    branch: 'fix/migration-safety-very-long-branch-name-that-keeps-going-and-going',
    agentType: 'openai-codex',
    taskMode: 'conversation',
    agentProfileHint: 'Default',
  },
  {
    id: 'typical',
    name: 'Typical session',
    title: 'Add dark mode toggle to settings page',
    initialPrompt: 'Add a dark mode toggle to the application settings page. Make sure it persists across reloads.',
    profile: 'full',
    status: 'active',
    ports: makePorts(2),
    workspaceName: 'dark-mode-toggle',
    vmSize: 'cpx31',
    nodeName: 'node-hetzner-nbg1-warm',
    provider: 'hetzner',
    branch: 'feature/dark-mode-toggle',
    agentType: 'claude-code',
    taskMode: 'task',
    agentProfileHint: 'Frontend Engineer',
  },
  {
    id: 'minimal',
    name: 'Minimal / short',
    title: 'Hi',
    initialPrompt: 'Hi',
    profile: 'lightweight',
    status: 'stopped',
    ports: [],
    workspaceName: 'ws-x',
    vmSize: 'cpx11',
    nodeName: 'node-a',
    provider: 'hetzner',
    agentType: 'claude-code',
    taskMode: 'conversation',
  },
  {
    id: 'medium-ports',
    name: '12 ports + medium title',
    title: 'Wire up the new observability dashboard with live AI Gateway usage metrics',
    initialPrompt:
      'Build the per-user LLM usage dashboard. Pull data from AI Gateway logs, break it down by model and by day, and add a budget-remaining indicator.',
    lineageText: '↩ attempt 3',
    profile: 'full',
    status: 'active',
    ports: makePorts(12),
    workspaceName: 'observability-dashboard',
    vmSize: 'cpx41',
    nodeName: 'node-hetzner-fsn1-dedicated',
    provider: 'hetzner',
    branch: 'feature/ai-usage-dashboard',
    agentType: 'claude-code',
    taskMode: 'task',
    agentProfileHint: 'Full-stack Engineer',
  },
];
