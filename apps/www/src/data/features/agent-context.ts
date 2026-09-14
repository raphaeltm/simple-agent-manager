import type { FeatureSection } from './types';

export const agentContextSection: FeatureSection = {
  slug: 'agent-context',
  label: 'Agents That Learn',
  title: 'Agents that remember\nyour preferences.',
  subtitle:
    'Build a project knowledge base that agents receive as context. Set policies that are injected into every session. Review a full log of agent activity.',
  summary:
    'A project knowledge base agents receive as context, plus policies and a full activity log.',
  highlights: [
    'Project memory entries carry a confidence score, a source, and a confirmation date',
    'Policies are injected into every agent session as instruction-only context',
    'A full activity log of every task, session, and execution event',
  ],
  docsHref: '/docs/guides/agents/',
  group: 'govern',
  screenshots: [
    {
      src: '/images/features/agent-context-overview.png',
      alt: 'Agent context overview showing memory entities (25), active policies (12), recent actions (50), and the context stack agents receive',
      caption: 'Overview of the context stack — repo instructions, memory, policies, and profiles',
    },
  ],
  details: [
    {
      headline: 'Persistent project memory',
      body: 'Store observations about your architecture, conventions, and preferences. Each entry has a confidence score, a source (explicit or inferred), and a confirmation date so you can see what the knowledge base contains.',
      screenshot: {
        src: '/images/features/agent-memory.png',
        alt: 'Memory observations about mobile UX, resource scheduling, and tool authorization, each with 92–95% confidence and confirmation dates',
        caption: 'Each observation shows confidence, source, and when it was last confirmed',
      },
    },
    {
      headline: 'Project policies',
      body: 'Define project-level instructions like "use portals for modals" or "CLI packages must meet QA standards." Policies are tagged as preferences or rules and injected into every agent session as context.',
      screenshot: {
        src: '/images/features/agent-policies.png',
        alt: 'Policies page showing preference and rule entries with confidence scores, marked as instruction-only',
        caption:
          'Policies are instruction-only — injected into agent context, not programmatically enforced',
      },
    },
    {
      headline: 'Activity log',
      body: 'A timestamped feed of every task submission, execution step, session start/stop, and agent completion event. Filter to find specific activity across the project.',
      screenshot: {
        src: '/images/features/agent-actions.png',
        alt: 'Agent actions feed showing task.agent_completed, task.execution_step, session.stopped, and session.started events with timestamps',
        caption: 'Every event type — task completions, execution steps, session lifecycle changes',
      },
    },
  ],
};
