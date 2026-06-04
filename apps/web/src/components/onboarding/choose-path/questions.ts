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

/**
 * Constructs one answer option. Positional arguments keep each option on a
 * single call so the question table reads as data, not repeated object
 * literals.
 */
function opt(
  id: string,
  label: string,
  description: string,
  icon: string,
  next: string | null,
  tags: string[]
): PathOption {
  return { id, label, description, icon, next, tags };
}

export const QUESTIONS: PathQuestion[] = [
  {
    id: 'ai-subscription',
    question: 'How do you want to power your AI agent?',
    description:
      'SAM uses AI agents like Claude Code to write code. Pick how you want to pay for AI usage.',
    options: [
      opt(
        'claude-pro',
        'Claude Pro or Max subscription',
        'Use your existing Anthropic subscription — no extra AI cost',
        'C',
        'cloud-account',
        ['has-claude', 'oauth']
      ),
      opt(
        'api-key',
        'I have an API key',
        'Anthropic or OpenAI API key for direct pay-per-token usage',
        '\u{1F511}',
        'which-api-key',
        ['has-api-key', 'user-api-key']
      ),
      opt(
        'nothing',
        'Use SAM-managed AI',
        'Route AI usage through SAM — no key or setup needed, works with any agent. Switch to your own key anytime.',
        '\u{2728}',
        'cloud-account',
        ['no-ai', 'sam-billing']
      ),
    ],
  },
  {
    id: 'which-api-key',
    question: 'Which API key do you have?',
    description:
      'With your own API key, you pay per-token directly to the provider.',
    options: [
      opt('anthropic', 'Anthropic (Claude)', 'For Claude Code agent', 'C', 'cloud-account', [
        'has-claude',
        'anthropic-key',
      ]),
      opt('openai', 'OpenAI', 'For Codex agent', 'O', 'cloud-account', ['has-openai', 'openai-key']),
    ],
  },
  {
    id: 'cloud-account',
    question: 'Do you have a cloud hosting account?',
    description:
      'AI agents need a real computer to run on. SAM creates temporary VMs for each task.',
    options: [
      opt(
        'hetzner',
        'I have Hetzner',
        'Most cost-effective — you pay Hetzner directly for usage',
        'H',
        'github-ready',
        ['has-hetzner', 'byoc']
      ),
      opt(
        'no-cloud',
        'Use SAM-managed infrastructure',
        'Let SAM provision and manage VMs for you — bring your own Hetzner account anytime.',
        '\u{1F680}',
        'github-ready',
        ['no-cloud', 'sam-infra']
      ),
    ],
  },
  {
    id: 'github-ready',
    question: 'Do you have a GitHub repo ready?',
    description:
      "SAM agents work on real code. You'll connect GitHub so they can clone repos and open PRs.",
    options: [
      opt(
        'yes',
        'Yes, I have a repo',
        'I have a project I want to work on',
        '\u{1F4C2}',
        null,
        ['has-repo']
      ),
      opt(
        'no-repo',
        "Not yet, I'll pick one after connecting",
        'Connect GitHub first, then choose or fork a repo',
        '\u{1F517}',
        null,
        ['no-repo']
      ),
    ],
  },
];
