/**
 * Generates a personalized setup path based on the user's answers (tags).
 *
 * Each step maps to a real action the user will take, backed by real API calls
 * in the execution phase.
 */

export type StepId = 'ai-oauth' | 'ai-apikey' | 'ai-sam' | 'cloud-hetzner' | 'cloud-sam' | 'github' | 'project';

export interface GeneratedStep {
  id: StepId;
  title: string;
  description: string;
  actionLabel: string;
  timeEstimate: string;
  details: string[];
  /** Steps marked optional are already handled and shown as "Done" */
  isOptional: boolean;
}

export function generatePath(tags: string[]): GeneratedStep[] {
  const steps: GeneratedStep[] = [];

  // AI Agent setup
  if (tags.includes('oauth') && tags.includes('has-claude')) {
    steps.push({
      id: 'ai-oauth',
      title: 'Connect your Claude subscription',
      description:
        'After setup, connect your Claude Pro/Max plan in Settings. No API key needed — no extra cost.',
      actionLabel: 'Continue',
      timeEstimate: '30 seconds',
      details: [
        'Connect in Settings → Agent Settings after setup',
        'SAM uses your existing subscription quota',
        'No additional billing — covered by your plan',
        'You can disconnect anytime from Settings',
      ],
      isOptional: tags.includes('existing-agent'),
    });
  } else if (tags.includes('user-api-key')) {
    steps.push({
      id: 'ai-apikey',
      title: 'Enter your API key',
      description:
        "Paste your API key and SAM encrypts it securely. You pay per-token directly to the provider.",
      actionLabel: 'Save API Key',
      timeEstimate: '1 minute',
      details: [
        'Your key is encrypted and stored securely',
        'SAM never shares your key with third parties',
        'You pay the provider directly for token usage',
        'You can set spending alerts in Settings',
      ],
      isOptional: tags.includes('existing-agent'),
    });
  } else if (tags.includes('sam-billing')) {
    steps.push({
      id: 'ai-sam',
      title: 'Use SAM-managed AI',
      description:
        'Route your AI usage through SAM — no key or setup needed, works with any agent. Switch to your own key anytime.',
      actionLabel: 'Continue',
      timeEstimate: '30 seconds',
      details: [
        'No API key to manage — SAM handles AI access for you',
        'Works with Claude Code, Codex, and OpenCode alike',
        'Daily token budget and monthly cap keep spend predictable',
        'You can switch to your own API key anytime',
      ],
      isOptional: tags.includes('existing-agent'),
    });
  }

  // Cloud infrastructure
  if (tags.includes('byoc')) {
    steps.push({
      id: 'cloud-hetzner',
      title: 'Connect your Hetzner account',
      description:
        'Paste your Hetzner API token. SAM creates and destroys VMs automatically for each task.',
      actionLabel: 'Enter Hetzner Token',
      timeEstimate: '1 minute',
      details: [
        'Generate a token at console.hetzner.cloud',
        'SAM creates right-sized VMs for workspaces',
        'VMs are destroyed when tasks complete',
        'You choose the region and VM size',
      ],
      isOptional: tags.includes('existing-cloud'),
    });
  } else {
    steps.push({
      id: 'cloud-sam',
      title: 'Infrastructure handled by SAM',
      description:
        'No setup needed! SAM provides cloud infrastructure. You can bring your own account later for more control.',
      actionLabel: 'Continue',
      timeEstimate: 'Instant',
      details: [
        'SAM manages VMs in European data centers',
        'Infrastructure cost included in per-task billing',
        'Switch to your own Hetzner account later for savings',
        'Data isolated per-user — no shared VMs',
      ],
      isOptional: tags.includes('existing-cloud'),
    });
  }

  // GitHub
  steps.push({
    id: 'github',
    title: 'Install SAM GitHub App',
    description:
      'Give SAM access to your repos so agents can clone code and open PRs. You choose which repos.',
    actionLabel: 'Install GitHub App',
    timeEstimate: '30 seconds',
    details: [
      'You choose which repos SAM can access',
      'Agents create branches and open PRs on your behalf',
      'Agents never push directly to main',
      'Change repo access anytime from GitHub settings',
    ],
    isOptional: tags.includes('existing-github'),
  });

  // First project
  if (tags.includes('has-repo')) {
    steps.push({
      id: 'project',
      title: 'Create your first project',
      description: 'Select one of your GitHub repos to create your first SAM project.',
      actionLabel: 'Choose Repository',
      timeEstimate: '30 seconds',
      details: [
        'Pick a repo from your connected GitHub account',
        'SAM clones it when creating workspaces',
        'Default branch detected automatically',
        'Add more projects later',
      ],
      isOptional: false,
    });
  } else {
    steps.push({
      id: 'project',
      title: 'Create your first project',
      description:
        'Pick any repo from your GitHub account, or fork an open-source project to get started.',
      actionLabel: 'Choose Repository',
      timeEstimate: '30 seconds',
      details: [
        'Pick any repo you have access to',
        'Try forking github.com/raphaeltm/simple-agent-manager to experiment',
        'SAM clones it when creating workspaces',
        'You can add more projects later',
      ],
      isOptional: false,
    });
  }

  return steps;
}

export function getTimeEstimate(steps: GeneratedStep[]): string {
  let totalSeconds = 0;
  for (const step of steps) {
    if (step.isOptional) continue;
    const match = step.timeEstimate.match(/(\d+)/);
    if (match?.[1]) {
      const num = parseInt(match[1], 10);
      if (step.timeEstimate.includes('minute')) totalSeconds += num * 60;
      else totalSeconds += num;
    }
  }
  const minutes = Math.ceil(totalSeconds / 60);
  if (minutes === 0) return '< 1 min';
  return `~${minutes} min${minutes !== 1 ? 's' : ''}`;
}
