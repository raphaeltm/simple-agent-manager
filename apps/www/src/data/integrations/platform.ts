/**
 * Code hosting, model access, and the docs-only connection links on the hub.
 *
 * Workers AI facts: task titles go through AI Gateway (apps/api/src/services/task-title.ts); text to
 * speech and voice transcription call the AI binding directly (services/tts.ts, routes/transcribe.ts).
 * SAM proxy mode exists for Claude Code and Codex only (AgentSettingsCard.tsx supportsSamProvider).
 */
import { faq, feature, type ConnectionLink, type Integration, step } from './types';

export const codeHostingIntegrations: Integration[] = [
  {
    slug: 'github',
    name: 'GitHub',
    category: 'code-hosting',
    tagline: 'GitHub App access, sign-in, and event triggers',
    description:
      "Install your installation's GitHub App on the repositories you choose. Agents clone, branch and push with the App's installation token, open pull requests when asked, and GitHub events can start work.",
    logoPath: '/images/integrations/github.svg',
    seoTitle: 'GitHub Integration for AI Coding Agents | SAM',
    seoDescription:
      'Connect GitHub repositories to SAM through a GitHub App. Agents push branches and open pull requests, and issues, comments, pull requests and pushes can start agent work.',
    features: [
      feature(
        'GitHub App access',
        'You choose which repositories the App can reach. Agents use its installation token, not your personal token.'
      ),
      feature(
        'Pull requests when asked',
        'Agents work on their own branches, push them when a task is done, and open a pull request when you ask.'
      ),
      feature(
        'Event triggers',
        'An issue, issue comment, pull request or push that matches your filters can start an agent with a saved profile.'
      ),
      feature(
        'Sign in with GitHub',
        'One of the sign-in options your installation can offer, alongside Google, GitLab and email codes.'
      ),
    ],
    howItWorks: [
      step(
        'Create the App',
        "The self-hosting guide's wizard creates your installation's own GitHub App with its settings filled in."
      ),
      step(
        'Install it',
        'Install the App on an organization or account and pick the repositories it can access.'
      ),
      step('Create a project', 'Choose a repository when you create a SAM project.'),
      step('Run agents', "Agents clone, branch, commit and push with the App's token."),
    ],
    useCases: [
      feature(
        'Issue triage',
        'Start an agent for each new issue with a given label and have it investigate.'
      ),
      feature(
        'Comment commands',
        'Let teammates trigger an agent from a pull request or issue comment.'
      ),
      feature(
        'Several repositories',
        'One project per repository, with agents running across all of them.'
      ),
    ],
    faq: [
      faq(
        'Which permissions does the App need?',
        'Contents read and write, plus read-only metadata, email, pull requests, checks, actions and issues. Grant pull requests read and write only if agents should open pull requests. The self-hosting guide walks through it.'
      ),
      faq(
        'Do agents use my GitHub token?',
        'No. Repository operations use the GitHub App installation token. Your personal sign-in is used to sign you in to SAM.'
      ),
      faq(
        'Does SAM support GitHub Enterprise Server?',
        'No. SAM supports GitHub.com. For a self-managed Git server, GitLab with a custom host is supported.'
      ),
    ],
    relatedSlugs: ['gitlab', 'claude-code', 'codex'],
    externalUrl: 'https://docs.github.com/en/apps',
    externalLabel: 'GitHub Apps docs',
    docsPath: '/docs/guides/self-hosting/',
  },
  {
    slug: 'gitlab',
    name: 'GitLab',
    category: 'code-hosting',
    tagline: 'GitLab.com or your own GitLab server',
    description:
      "Back a project with a GitLab repository. SAM uses the project owner's GitLab sign-in to clone and push, and your administrator can point SAM at GitLab.com or a self-managed GitLab host.",
    logoPath: '/images/integrations/gitlab.svg',
    seoTitle: 'GitLab Integration for AI Coding Agents | SAM',
    seoDescription:
      'Run SAM coding agents against GitLab repositories on GitLab.com or a self-managed GitLab server. Agents push branches you can turn into merge requests.',
    features: [
      feature(
        'GitLab.com or self-managed',
        'The administrator sets the GitLab host, client ID and secret in Admin → Integrations.'
      ),
      feature(
        'Sign in with GitLab',
        'Users can sign in to SAM with GitLab when the administrator enables it.'
      ),
      feature(
        'Branches, not surprises',
        'On a GitLab project the agent pushes its branch, and you open the merge request in GitLab.'
      ),
    ],
    howItWorks: [
      step(
        'Configure GitLab OAuth',
        'The administrator registers an OAuth application in GitLab and enters it in Admin → Integrations.'
      ),
      step('Connect your account', 'Sign in with GitLab so SAM can reach your repositories.'),
      step('Create a project', 'Pick a GitLab repository when you create the project.'),
    ],
    useCases: [
      feature(
        'Self-managed Git',
        'Keep source on your own GitLab server while agents run on your own cloud.'
      ),
      feature(
        'Mixed teams',
        'Run GitHub-backed and GitLab-backed projects in the same installation.'
      ),
    ],
    faq: [
      faq(
        'Whose access does SAM use?',
        "The project owner's GitLab sign-in, which reaches the projects that account can reach."
      ),
      faq(
        'Can agents open merge requests?',
        'Not yet. Agents push a branch, and you open the merge request in GitLab.'
      ),
      faq(
        'Do GitHub event triggers work for GitLab?',
        'No. Use a webhook trigger from GitLab instead.'
      ),
    ],
    relatedSlugs: ['github', 'claude-code', 'opencode'],
    externalUrl: 'https://docs.gitlab.com/integration/oauth_provider/',
    externalLabel: 'GitLab OAuth docs',
    docsPath: '/docs/guides/admin-settings/',
  },
];

export const modelAccessIntegrations: Integration[] = [
  {
    slug: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    shortName: 'Workers AI',
    category: 'model-access',
    tagline: 'Built-in models for SAM features and for your agents',
    description:
      'Workers AI comes with the Cloudflare account that runs SAM. SAM uses it for task titles, text to speech, voice input and the SAM assistant, and agents can call its models while they work within a monthly budget.',
    logoPath: '/images/integrations/cloudflare.svg',
    seoTitle: 'Built-in AI with Cloudflare Workers AI | SAM',
    seoDescription:
      'SAM uses Cloudflare Workers AI for task titles, text to speech, voice input and the SAM assistant, and lets agents call Workers AI models within a monthly budget.',
    features: [
      feature(
        'No separate model key',
        'Workers AI is billed to the Cloudflare account that runs your SAM installation.'
      ),
      feature(
        'Models for your agents',
        'Agents can call Workers AI models, such as a yes-or-no decision model or Whisper for transcription, within a monthly budget per project.'
      ),
      feature(
        'Platform features',
        'Task titles, reading messages aloud, voice input and the SAM assistant use Workers AI models.'
      ),
      feature(
        'AI Gateway where it fits',
        'Task titles and the AI proxy go through Cloudflare AI Gateway for logging and limits. Speech and transcription call the model directly.'
      ),
    ],
    howItWorks: [
      step(
        'Already built in',
        'Workers AI is bound to the SAM Worker when you deploy. There is nothing to connect.'
      ),
      step(
        'Set a budget',
        'Give agents a monthly budget for Workers AI calls in project settings.'
      ),
      step('Watch usage', 'Administrators see AI usage and cost on the admin pages.'),
    ],
    useCases: [
      feature(
        'Small decisions inside a task',
        "Let an agent ask a cheap model a yes-or-no question instead of spending its main model's tokens."
      ),
      feature('Speech in and out', 'Dictate prompts and have replies read aloud.'),
    ],
    faq: [
      faq(
        'Does Workers AI need its own API key?',
        'No. It uses the Cloudflare account that runs SAM. Self-hosting SAM needs the Workers Paid plan.'
      ),
      faq(
        'Can my coding agent use Workers AI as its main model?',
        'Not directly. Coding agents use their own providers. Agents can call Workers AI models as a tool alongside their main model.'
      ),
      faq(
        'Which models does SAM use?',
        'Gemma 4 26B for task titles and preparing text for speech, Deepgram Aura 2 for text to speech and Whisper for voice input. The SAM assistant and AI proxy models are set per installation.'
      ),
    ],
    relatedSlugs: ['claude-code', 'codex', 'opencode'],
    externalUrl: 'https://developers.cloudflare.com/workers-ai/',
    externalLabel: 'Workers AI docs',
    docsPath: '/docs/guides/ai-models-for-agents/',
  },
];

/** Shipped capabilities with a docs page and no detail page of their own. */
export const automationLinks: ConnectionLink[] = [
  {
    name: 'Schedules',
    description: 'Run a profile on a cron schedule or once at a set time.',
    href: '/docs/guides/scheduled-actions/',
    icon: 'clock',
  },
  {
    name: 'GitHub events',
    description: 'Start work from issues, comments, pull requests or pushes that match filters.',
    href: '/docs/guides/triggers/',
    icon: 'github',
  },
  {
    name: 'Webhooks and Slack',
    description:
      "Start work from any JSON webhook. Signed requests, including Slack's, are verified.",
    href: '/docs/guides/webhook-triggers/',
    icon: 'webhook',
  },
  {
    name: 'Email (preview)',
    description:
      'Give an automation its own address. Mail from allowed senders starts it, and it can reply.',
    href: '/docs/guides/email-triggers/',
    icon: 'mail',
  },
];

export const connectLinks: ConnectionLink[] = [
  {
    name: 'Claude and ChatGPT',
    description:
      'Check on work, start chats and answer agents from Claude or ChatGPT through the SAM Connector.',
    href: '/docs/guides/sam-connector/',
    icon: 'chat',
  },
  {
    name: 'MCP servers',
    description:
      'Give agents tools from any MCP endpoint, such as Linear, Notion, Zapier or Composio.',
    href: '/docs/guides/mcp-servers/',
    icon: 'plug',
  },
  {
    name: 'Workload identity',
    description: 'Short-lived OIDC tokens for Vault, AWS or GCP instead of stored keys.',
    href: '/docs/guides/workload-identity/',
    icon: 'key',
  },
  {
    name: 'Web Push',
    description: 'Notifications when tasks finish or agents ask a question.',
    href: '/docs/guides/notifications/',
    icon: 'bell',
  },
];

export const modelAccessLinks: ConnectionLink[] = [
  {
    name: 'Installation AI proxy',
    description:
      'Claude Code and Codex can use a proxy your administrator runs through Cloudflare AI Gateway, with per-user budgets and model tiers. Opt-in.',
    href: '/docs/guides/agents/#ai-provider-modes',
    icon: 'gauge',
  },
  {
    name: 'Compatible providers',
    description:
      "OpenRouter, Groq, DeepSeek, Cohere and other OpenAI- or Anthropic-compatible APIs as an agent's backend.",
    href: '/docs/guides/agents/',
    icon: 'route',
  },
];

export const runtimeLinks: ConnectionLink[] = [
  {
    name: 'Instant sessions',
    description:
      'Cloudflare Containers that start in seconds with no cloud account. No devcontainer or Docker.',
    href: '/docs/guides/instant-sessions/',
    icon: 'container',
  },
  {
    name: 'App deployments',
    description:
      'Run the apps your agents build on deployment nodes, with persistent volumes on most providers.',
    href: '/docs/guides/app-deployments/',
    icon: 'rocket',
  },
];
