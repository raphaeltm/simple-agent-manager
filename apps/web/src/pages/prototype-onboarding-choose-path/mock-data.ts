/**
 * PROTOTYPE ONLY — DO NOT SHIP TO PRODUCTION
 * Mock data for the Choose-Your-Path onboarding prototype.
 */

export interface PathQuestion {
  id: string;
  question: string;
  description: string;
  options: PathOption[];
}

export interface PathOption {
  id: string;
  label: string;
  description: string;
  icon: string;
  next: string | null; // next question ID or null for end
  tags: string[]; // tags that affect the generated path
}

export const QUESTIONS: PathQuestion[] = [
  {
    id: 'experience',
    question: 'How familiar are you with AI coding tools?',
    description: 'This helps us adjust the level of explanation at each step.',
    options: [
      {
        id: 'new',
        label: 'Brand new',
        description: "I've heard of them but never used one",
        icon: '🌱',
        next: 'ai-subscription',
        tags: ['beginner'],
      },
      {
        id: 'some',
        label: 'Some experience',
        description: "I've used Copilot, Cursor, or similar tools",
        icon: '🌿',
        next: 'ai-subscription',
        tags: ['intermediate'],
      },
      {
        id: 'expert',
        label: 'Very familiar',
        description: "I use AI coding tools daily",
        icon: '🌳',
        next: 'ai-subscription',
        tags: ['expert'],
      },
    ],
  },
  {
    id: 'ai-subscription',
    question: 'Do you have an AI subscription?',
    description:
      "SAM uses AI agents like Claude Code or Codex. If you already pay for one, you can use it here — no extra AI cost.",
    options: [
      {
        id: 'claude-pro',
        label: 'Claude Pro or Max ($20-100/mo)',
        description: "I have an Anthropic subscription I'd like to use",
        icon: 'C',
        next: 'cloud-account',
        tags: ['has-claude', 'oauth'],
      },
      {
        id: 'chatgpt-plus',
        label: 'ChatGPT Plus or Pro ($20-200/mo)',
        description: "I have an OpenAI subscription I'd like to use",
        icon: 'O',
        next: 'cloud-account',
        tags: ['has-openai', 'oauth'],
      },
      {
        id: 'api-key',
        label: 'I have an API key',
        description: 'I have an Anthropic or OpenAI API key for direct usage',
        icon: '🔑',
        next: 'which-api-key',
        tags: ['has-api-key', 'user-api-key'],
      },
      {
        id: 'nothing',
        label: "I don't have anything yet",
        description: "No worries — SAM can handle billing for you",
        icon: '✨',
        next: 'cloud-account',
        tags: ['no-ai', 'sam-billing'],
      },
    ],
  },
  {
    id: 'which-api-key',
    question: 'Which API key do you have?',
    description:
      "With your own API key, you pay per-token directly to the provider. Most cost-effective for heavy use.",
    options: [
      {
        id: 'anthropic',
        label: 'Anthropic (Claude)',
        description: 'For Claude Code agent — starts with sk-ant-...',
        icon: 'C',
        next: 'cloud-account',
        tags: ['has-claude', 'anthropic-key'],
      },
      {
        id: 'openai',
        label: 'OpenAI',
        description: 'For Codex agent — starts with sk-...',
        icon: 'O',
        next: 'cloud-account',
        tags: ['has-openai', 'openai-key'],
      },
    ],
  },
  {
    id: 'cloud-account',
    question: 'Do you have a cloud hosting account?',
    description:
      "AI agents need a real computer to run on. SAM creates temporary VMs for each task. If you have a Hetzner account, you can use it. If not, SAM can provide infrastructure.",
    options: [
      {
        id: 'hetzner',
        label: 'I have Hetzner',
        description: 'Most cost-effective: ~$5-20/mo for typical use',
        icon: 'H',
        next: 'github-ready',
        tags: ['has-hetzner', 'byoc'],
      },
      {
        id: 'other-cloud',
        label: 'I have AWS/GCP/other',
        description: "SAM doesn't support those yet, but can provide infrastructure",
        icon: '☁️',
        next: 'github-ready',
        tags: ['no-hetzner', 'sam-infra'],
      },
      {
        id: 'no-cloud',
        label: "I don't have a cloud account",
        description: "No problem — SAM provides infrastructure for you",
        icon: '🚀',
        next: 'github-ready',
        tags: ['no-cloud', 'sam-infra'],
      },
    ],
  },
  {
    id: 'github-ready',
    question: 'Do you have a GitHub repo ready?',
    description:
      "SAM agents work on real code. You'll connect GitHub so they can clone repos and open PRs.",
    options: [
      {
        id: 'yes',
        label: 'Yes, I have a repo',
        description: "I have a project I want to work on",
        icon: '📂',
        next: null,
        tags: ['has-repo'],
      },
      {
        id: 'template',
        label: "I'll use a template",
        description: "Give me a starter project to try SAM with",
        icon: '📋',
        next: null,
        tags: ['use-template'],
      },
    ],
  },
];

export interface GeneratedStep {
  id: string;
  title: string;
  description: string;
  action: string;
  timeEstimate: string;
  details: string[];
  isOptional: boolean;
}

export function generatePath(tags: string[]): GeneratedStep[] {
  const steps: GeneratedStep[] = [];

  // Step 1: AI Agent setup (varies by tag)
  if (tags.includes('oauth') && tags.includes('has-claude')) {
    steps.push({
      id: 'ai',
      title: 'Connect your Claude subscription',
      description:
        "Since you have a Claude Pro/Max subscription, we'll connect it via OAuth. No API key needed — no extra cost.",
      action: 'Connect Claude Account',
      timeEstimate: '30 seconds',
      details: [
        "You'll be redirected to Anthropic to approve access",
        'SAM uses your existing subscription quota',
        'No additional billing — this is covered by your $20-100/mo plan',
        'You can disconnect anytime from Settings',
      ],
      isOptional: false,
    });
  } else if (tags.includes('oauth') && tags.includes('has-openai')) {
    steps.push({
      id: 'ai',
      title: 'Connect your ChatGPT subscription',
      description:
        "Since you have a ChatGPT subscription, we'll connect it via OAuth. Your existing plan covers the usage.",
      action: 'Connect OpenAI Account',
      timeEstimate: '30 seconds',
      details: [
        "You'll be redirected to OpenAI to approve access",
        'SAM uses your existing subscription quota',
        'No additional billing beyond your current plan',
        'You can disconnect anytime from Settings',
      ],
      isOptional: false,
    });
  } else if (tags.includes('user-api-key')) {
    steps.push({
      id: 'ai',
      title: 'Enter your API key',
      description:
        "You'll paste your API key and SAM encrypts it securely. You pay per-token directly to the provider.",
      action: 'Enter API Key',
      timeEstimate: '1 minute',
      details: [
        'Your key is encrypted and stored securely',
        'SAM never shares your key with third parties',
        'You pay per-token based on usage (~$0.01-1.50 per task)',
        'You can set spending alerts in Settings',
      ],
      isOptional: false,
    });
  } else if (tags.includes('sam-billing')) {
    steps.push({
      id: 'ai',
      title: 'SAM-managed AI billing',
      description:
        "No setup needed! SAM handles AI billing through Cloudflare. You set a daily budget and monthly cap.",
      action: 'Set Budget (optional)',
      timeEstimate: '30 seconds',
      details: [
        'SAM provides AI access through Cloudflare AI Gateway',
        'You set a daily token budget (default: 100K tokens/day)',
        'Monthly cost cap ensures you never overspend',
        'Typical cost: $5-30/month for moderate use',
        'You can switch to your own API key anytime',
      ],
      isOptional: false,
    });
  }

  // Step 2: Cloud infrastructure
  if (tags.includes('byoc')) {
    steps.push({
      id: 'cloud',
      title: 'Connect your Hetzner account',
      description:
        "Paste your Hetzner API token. SAM will create and destroy VMs automatically for each task.",
      action: 'Enter Hetzner Token',
      timeEstimate: '1 minute',
      details: [
        'Generate a token at console.hetzner.cloud → Security → API Tokens',
        'SAM creates small VMs (~$5/mo) for agent workspaces',
        'VMs are destroyed when tasks complete — you only pay for active time',
        'You choose the region and VM size',
      ],
      isOptional: false,
    });
  } else {
    steps.push({
      id: 'cloud',
      title: 'Infrastructure handled by SAM',
      description:
        "No setup needed! SAM provides cloud infrastructure for your agents. You can bring your own account later for more control and lower cost.",
      action: 'Continue (nothing to do)',
      timeEstimate: '0 seconds',
      details: [
        'SAM manages VMs in European data centers',
        'Infrastructure cost included in per-task billing',
        'You can switch to your own Hetzner account later for 40-60% savings',
        'Data isolated per-user — no shared VMs',
      ],
      isOptional: true,
    });
  }

  // Step 3: GitHub
  steps.push({
    id: 'github',
    title: 'Install SAM GitHub App',
    description:
      "Give SAM access to your repos so agents can clone code and open PRs. You choose which repos to share.",
    action: 'Install GitHub App',
    timeEstimate: '30 seconds',
    details: [
      'SAM installs as a GitHub App — you choose which repos it accesses',
      'Agents will create branches and open PRs on your behalf',
      'You always review and merge — agents never push directly to main',
      'You can change repo access anytime from GitHub settings',
    ],
    isOptional: false,
  });

  // Step 4: First project
  if (tags.includes('has-repo')) {
    steps.push({
      id: 'project',
      title: 'Import your project',
      description: 'Select one of your GitHub repos to create your first SAM project.',
      action: 'Choose Repository',
      timeEstimate: '30 seconds',
      details: [
        'Pick a repo from your connected GitHub account',
        'SAM will clone it when creating workspaces',
        'Your default branch is detected automatically',
        'You can add more projects later',
      ],
      isOptional: false,
    });
  } else {
    steps.push({
      id: 'project',
      title: 'Start with a template',
      description:
        "We'll create a starter project for you to try SAM with. You can import your own repos later.",
      action: 'Choose Template',
      timeEstimate: '30 seconds',
      details: [
        'Choose from Next.js, Express, FastAPI, or other templates',
        'SAM forks it to your GitHub account',
        'Great for learning how SAM works before using your own code',
        'You can switch to a real repo anytime',
      ],
      isOptional: false,
    });
  }

  // Step 5: First task
  steps.push({
    id: 'first-task',
    title: 'Submit your first task',
    description: 'Type what you want built and watch the agent work!',
    action: 'Start Building',
    timeEstimate: '30 seconds',
    details: [
      'Describe a feature, bug fix, or improvement',
      'SAM provisions a workspace and starts your agent',
      'Watch the agent work in real-time via the chat',
      "You'll get a PR to review when it's done",
    ],
    isOptional: false,
  });

  return steps;
}

export function getTimeEstimate(steps: GeneratedStep[]): string {
  let totalSeconds = 0;
  for (const step of steps) {
    const match = step.timeEstimate.match(/(\d+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (step.timeEstimate.includes('minute')) totalSeconds += num * 60;
      else totalSeconds += num;
    }
  }
  const minutes = Math.ceil(totalSeconds / 60);
  return `~${minutes} minute${minutes !== 1 ? 's' : ''}`;
}
