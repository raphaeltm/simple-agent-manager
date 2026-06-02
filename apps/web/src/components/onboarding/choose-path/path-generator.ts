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
        "We'll connect your Claude Pro/Max subscription via OAuth. No API key needed — no extra cost.",
      actionLabel: 'Connect Claude Account',
      timeEstimate: '30 seconds',
      details: [
        "You'll be redirected to Anthropic to approve access",
        'SAM uses your existing subscription quota',
        'No additional billing — covered by your plan',
        'You can disconnect anytime from Settings',
      ],
      isOptional: false,
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
        'Typical cost: ~$0.01-1.50 per task',
        'You can set spending alerts in Settings',
      ],
      isOptional: false,
    });
  } else if (tags.includes('sam-billing')) {
    steps.push({
      id: 'ai-sam',
      title: 'SAM-managed AI billing',
      description:
        'No setup needed! SAM handles AI billing through Cloudflare. Set a daily budget and monthly cap.',
      actionLabel: 'Set Budget',
      timeEstimate: '30 seconds',
      details: [
        'SAM provides AI access through Cloudflare AI Gateway',
        'Default: 100K tokens/day budget',
        'Monthly cost cap ensures you never overspend',
        'You can switch to your own API key anytime',
      ],
      isOptional: false,
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
        'SAM creates small VMs (~$5/mo) for workspaces',
        'VMs are destroyed when tasks complete',
        'You choose the region and VM size',
      ],
      isOptional: false,
    });
  } else {
    steps.push({
      id: 'cloud-sam',
      title: 'Infrastructure handled by SAM',
      description:
        'No setup needed! SAM provides cloud infrastructure. You can bring your own account later for more control.',
      actionLabel: 'Continue',
      timeEstimate: '0 seconds',
      details: [
        'SAM manages VMs in European data centers',
        'Infrastructure cost included in per-task billing',
        'Switch to your own Hetzner account later for savings',
        'Data isolated per-user — no shared VMs',
      ],
      isOptional: true,
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
    isOptional: false,
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
        "We'll create a starter project. You can import your own repos later.",
      actionLabel: 'Choose Template',
      timeEstimate: '30 seconds',
      details: [
        'Choose from starter templates',
        'Great for learning how SAM works',
        'Switch to a real repo anytime',
      ],
      isOptional: false,
    });
  }

  return steps;
}

export function getTimeEstimate(steps: GeneratedStep[]): string {
  let totalSeconds = 0;
  for (const step of steps) {
    const match = step.timeEstimate.match(/(\d+)/);
    if (match?.[1]) {
      const num = parseInt(match[1], 10);
      if (step.timeEstimate.includes('minute')) totalSeconds += num * 60;
      else totalSeconds += num;
    }
  }
  const minutes = Math.ceil(totalSeconds / 60);
  return `~${minutes} min${minutes !== 1 ? 's' : ''}`;
}
