import type { FeatureSection } from './types';

export const automationSection: FeatureSection = {
  slug: 'automation',
  label: 'Idea to Execution',
  title: 'From idea to\nagent-ready task.',
  subtitle:
    'Capture ideas with a problem statement and plan. Link the conversation that shaped them. When you are ready, dispatch an agent with one click.',
  summary:
    'Capture an idea with a plan, link the conversation that shaped it, and dispatch an agent with one click.',
  highlights: [
    'Capture a problem statement and a phased plan before dispatching an agent',
    'Link related chat conversations so the agent starts with the discussion that shaped the plan',
    'Dispatch an agent with one click once the idea is ready',
  ],
  docsHref: '/docs/guides/idea-execution/',
  group: 'automate',
  screenshots: [
    {
      src: '/images/features/ideas.png',
      alt: 'Idea detail page showing a problem description, phased implementation plan, Execute button, and a linked conversations sidebar',
      caption: 'Structured ideas with problem, plan, and an Execute button to dispatch an agent',
    },
  ],
  details: [
    {
      headline: 'Structured idea capture',
      body: 'Write down the problem, sketch a plan, and link related chat conversations for context. When you are ready, hit Execute to dispatch an agent that picks up the idea as a task.',
      screenshot: {
        src: '/images/features/ideas.png',
        alt: 'Idea detail page with problem description, phased plan, green Execute button, and conversations sidebar',
        caption: 'Each idea has a problem statement, plan, and a button to dispatch an agent',
      },
    },
    {
      headline: 'Link chat context',
      body: 'Attach related conversations to an idea before you dispatch it, so the agent that picks it up starts with the discussion that shaped the plan instead of a bare problem statement.',
      screenshot: {
        src: '/images/features/ideas.png',
        alt: 'Idea detail page showing linked conversations in the sidebar alongside the problem statement and plan',
        caption: 'Linked conversations sit beside the plan, so context travels with the idea',
      },
    },
  ],
};
