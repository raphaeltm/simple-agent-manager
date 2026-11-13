import { agentIntegrations } from './agents';
import { cloudIntegrations } from './clouds';
import { codeHostingIntegrations, modelAccessIntegrations } from './platform';
import type { Integration, IntegrationSection } from './types';

/** Every integration that has a detail page, in hub order. */
export const integrations: Integration[] = [
  ...agentIntegrations,
  ...cloudIntegrations,
  ...codeHostingIntegrations,
  ...modelAccessIntegrations,
];

/** Hub sections, each answering one question a buyer asks. */
export const sections: IntegrationSection[] = [
  {
    id: 'ai-agents',
    label: 'Coding agents',
    question: 'Which agents can my team run?',
    description:
      'Seven agents. Each user connects their own accounts, and a profile picks the agent and model for a chat or task.',
  },
  {
    id: 'cloud-providers',
    label: 'Where agents run',
    question: 'Whose machines do the agents use?',
    description:
      'Cloud VMs in an account connected to your installation, or Instant sessions on Cloudflare Containers.',
  },
  {
    id: 'model-access',
    label: 'Model access',
    question: 'Who pays for the model calls?',
    description:
      'Your own API keys and subscriptions by default. Optional ways to centralize or redirect model traffic.',
  },
  {
    id: 'code-hosting',
    label: 'Code hosting',
    question: 'Where does the code live?',
    description: 'GitHub.com through a GitHub App, or GitLab.com and self-managed GitLab.',
  },
  {
    id: 'automation',
    label: 'What starts work',
    question: 'Can work start without someone typing?',
    description: 'Saved profiles can run from schedules, repository events, webhooks and email.',
  },
  {
    id: 'connect',
    label: 'Connect other tools',
    question: 'How does SAM fit with the tools we already use?',
    description: 'Use SAM from AI apps, give agents more tools, and avoid storing long-lived keys.',
  },
];

export function getBySlug(slug: string): Integration | undefined {
  return integrations.find((i) => i.slug === slug);
}

export function getRelated(integration: Integration): Integration[] {
  return integration.relatedSlugs
    .map((slug) => getBySlug(slug))
    .filter((i): i is Integration => i !== undefined);
}
