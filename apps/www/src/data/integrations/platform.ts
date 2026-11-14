/**
 * Code hosting, model access, and the docs-only connection links on the hub.
 * Copy for the GitHub, GitLab and Workers AI pages lives in platform.json.
 *
 * Workers AI facts: task titles go through AI Gateway (apps/api/src/services/task-title.ts); text to
 * speech and voice transcription call the AI binding directly (services/tts.ts, routes/transcribe.ts).
 * SAM proxy mode exists for Claude Code and Codex only (AgentSettingsCard.tsx supportsSamProvider).
 */
import platform from './platform.json';
import { asIntegration, type ConnectionLink, type Integration } from './types';

const platformIntegrations: Integration[] = platform.map(asIntegration);

export const codeHostingIntegrations = platformIntegrations.filter(
  (i) => i.category === 'code-hosting'
);
export const modelAccessIntegrations = platformIntegrations.filter(
  (i) => i.category === 'model-access'
);

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
