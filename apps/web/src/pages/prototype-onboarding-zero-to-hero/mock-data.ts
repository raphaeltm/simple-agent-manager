/**
 * PROTOTYPE ONLY — DO NOT SHIP TO PRODUCTION
 * Mock data for the Zero-to-Hero onboarding walkthrough prototype.
 */

export interface MockAgent {
  id: string;
  name: string;
  provider: string;
  icon: string;
  description: string;
  credentialLabel: string;
  credentialHelp: string;
  subscriptionOptions: {
    name: string;
    description: string;
    cost: string;
    providerMode: string;
  }[];
}

export const MOCK_AGENTS: MockAgent[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    provider: 'Anthropic',
    icon: 'C',
    description:
      'Anthropic\'s coding agent. Works in a real terminal, runs tests, writes code, creates PRs.',
    credentialLabel: 'Anthropic API Key',
    credentialHelp: 'Get one at console.anthropic.com',
    subscriptionOptions: [
      {
        name: 'Use my API key',
        description:
          'Pay per token directly to Anthropic. You control costs. Best for heavy use.',
        cost: '~$0.003-0.015 per 1K tokens',
        providerMode: 'user-api-key',
      },
      {
        name: 'Use my Claude Pro/Max subscription',
        description:
          'Already paying for Claude Pro ($20/mo) or Max ($100/mo)? Use that subscription here — no extra cost.',
        cost: 'Included in your subscription',
        providerMode: 'oauth',
      },
      {
        name: 'Use SAM credits',
        description:
          'SAM handles billing through Cloudflare. Set a daily budget and monthly cap. Great for trying it out.',
        cost: 'Pay-as-you-go with budget controls',
        providerMode: 'sam',
      },
    ],
  },
  {
    id: 'openai-codex',
    name: 'Codex',
    provider: 'OpenAI',
    icon: 'O',
    description:
      'OpenAI\'s coding agent. Uses GPT-4 and o-series models for code generation and editing.',
    credentialLabel: 'OpenAI API Key',
    credentialHelp: 'Get one at platform.openai.com',
    subscriptionOptions: [
      {
        name: 'Use my API key',
        description:
          'Pay per token directly to OpenAI. Standard API pricing applies.',
        cost: '~$0.002-0.06 per 1K tokens',
        providerMode: 'user-api-key',
      },
      {
        name: 'Use my ChatGPT Pro subscription',
        description:
          'Use your existing ChatGPT Pro ($200/mo) subscription. OAuth-based authentication.',
        cost: 'Included in your subscription',
        providerMode: 'oauth',
      },
      {
        name: 'Use SAM credits',
        description:
          'SAM handles billing through Cloudflare. Budget controls included.',
        cost: 'Pay-as-you-go with budget controls',
        providerMode: 'sam',
      },
    ],
  },
];

export interface MockCloudProvider {
  id: string;
  name: string;
  description: string;
  credentialLabel: string;
  credentialHelp: string;
  pricing: string;
  locations: { id: string; name: string; flag: string }[];
  vmSizes: {
    name: string;
    label: string;
    specs: string;
    priceHourly: string;
    priceMonthly: string;
  }[];
}

export const MOCK_CLOUD_PROVIDERS: MockCloudProvider[] = [
  {
    id: 'hetzner',
    name: 'Hetzner',
    description:
      'European cloud provider. Great performance-per-dollar. Used by most SAM users.',
    credentialLabel: 'Hetzner API Token',
    credentialHelp: 'Create one at console.hetzner.cloud → your project → Security → API Tokens',
    pricing: 'Billed per hour of VM usage',
    locations: [
      { id: 'fsn1', name: 'Falkenstein, Germany', flag: '🇩🇪' },
      { id: 'nbg1', name: 'Nuremberg, Germany', flag: '🇩🇪' },
      { id: 'hel1', name: 'Helsinki, Finland', flag: '🇫🇮' },
      { id: 'ash', name: 'Ashburn, VA, USA', flag: '🇺🇸' },
    ],
    vmSizes: [
      {
        name: 'small',
        label: 'Small',
        specs: '2 vCPU, 4 GB RAM, 40 GB SSD',
        priceHourly: '~$0.007/hr',
        priceMonthly: '~$5/mo',
      },
      {
        name: 'medium',
        label: 'Medium',
        specs: '4 vCPU, 8 GB RAM, 80 GB SSD',
        priceHourly: '~$0.014/hr',
        priceMonthly: '~$10/mo',
      },
      {
        name: 'large',
        label: 'Large',
        specs: '8 vCPU, 16 GB RAM, 160 GB SSD',
        priceHourly: '~$0.028/hr',
        priceMonthly: '~$20/mo',
      },
    ],
  },
];

export const MOCK_REPOS = [
  {
    id: 1,
    name: 'my-saas-app',
    fullName: 'johndoe/my-saas-app',
    description: 'A Next.js SaaS starter template',
    language: 'TypeScript',
    defaultBranch: 'main',
    updatedAt: '2 hours ago',
  },
  {
    id: 2,
    name: 'portfolio-site',
    fullName: 'johndoe/portfolio-site',
    description: 'My personal portfolio website',
    language: 'JavaScript',
    defaultBranch: 'main',
    updatedAt: '3 days ago',
  },
  {
    id: 3,
    name: 'api-backend',
    fullName: 'johndoe/api-backend',
    description: 'REST API for the mobile app',
    language: 'Python',
    defaultBranch: 'main',
    updatedAt: '1 week ago',
  },
  {
    id: 4,
    name: 'open-source-lib',
    fullName: 'johndoe/open-source-lib',
    description: 'A utility library for data processing',
    language: 'Go',
    defaultBranch: 'main',
    updatedAt: '2 weeks ago',
  },
];

export const WALKTHROUGH_STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to SAM',
    subtitle: 'Your AI coding agent manager',
  },
  {
    id: 'concept',
    title: 'How SAM Works',
    subtitle: 'The 30-second version',
  },
  {
    id: 'agent',
    title: 'Choose Your AI Agent',
    subtitle: 'Step 1 of 4',
  },
  {
    id: 'billing',
    title: 'How You Pay for AI',
    subtitle: 'Step 2 of 4',
  },
  {
    id: 'cloud',
    title: 'Where Your Code Runs',
    subtitle: 'Step 3 of 4',
  },
  {
    id: 'github',
    title: 'Connect Your Code',
    subtitle: 'Step 4 of 4',
  },
  {
    id: 'first-task',
    title: 'Your First Task',
    subtitle: 'Let\'s build something!',
  },
] as const;
