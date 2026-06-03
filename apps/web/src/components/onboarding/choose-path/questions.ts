/**
 * Choose-Your-Path onboarding question definitions.
 *
 * Each question branches to the next based on the user's answer.
 * Tags accumulate and drive the generated setup path.
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
  /** Next question ID, or null to end the question phase */
  next: string | null;
  /** Tags that influence the generated path */
  tags: string[];
}

export const QUESTIONS: PathQuestion[] = [
  {
    id: 'ai-subscription',
    question: 'How do you want to power your AI agent?',
    description:
      'SAM uses AI agents like Claude Code to write code. Pick how you want to pay for AI usage.',
    options: [
      {
        id: 'claude-pro',
        label: 'Claude Pro or Max subscription',
        description: 'Use your existing Anthropic subscription — no extra AI cost',
        icon: 'C',
        next: 'cloud-account',
        tags: ['has-claude', 'oauth'],
      },
      {
        id: 'api-key',
        label: 'I have an API key',
        description: 'Anthropic or OpenAI API key for direct pay-per-token usage',
        icon: '\u{1F511}',
        next: 'which-api-key',
        tags: ['has-api-key', 'user-api-key'],
      },
      {
        id: 'nothing',
        label: "I don't have anything yet",
        description: "No worries — SAM can handle billing for you",
        icon: '\u{2728}',
        next: 'cloud-account',
        tags: ['no-ai', 'sam-billing'],
      },
    ],
  },
  {
    id: 'which-api-key',
    question: 'Which API key do you have?',
    description:
      'With your own API key, you pay per-token directly to the provider.',
    options: [
      {
        id: 'anthropic',
        label: 'Anthropic (Claude)',
        description: 'For Claude Code agent',
        icon: 'C',
        next: 'cloud-account',
        tags: ['has-claude', 'anthropic-key'],
      },
      {
        id: 'openai',
        label: 'OpenAI',
        description: 'For Codex agent',
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
      'AI agents need a real computer to run on. SAM creates temporary VMs for each task.',
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
        id: 'no-cloud',
        label: "I don't have a cloud account",
        description: 'No problem — SAM provides infrastructure for you',
        icon: '\u{1F680}',
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
        description: 'I have a project I want to work on',
        icon: '\u{1F4C2}',
        next: null,
        tags: ['has-repo'],
      },
      {
        id: 'template',
        label: "I'll use a template",
        description: 'Give me a starter project to try SAM with',
        icon: '\u{1F4CB}',
        next: null,
        tags: ['use-template'],
      },
    ],
  },
];
