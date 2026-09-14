import type { FeatureSection } from './types';

export const visibilitySection: FeatureSection = {
  slug: 'visibility',
  label: 'Full Visibility & Control',
  title: 'See everything.\nStay in control.',
  subtitle:
    'A dashboard for all your agent work. Track active tasks across projects, monitor node health across every cloud, and get notified when agents need your attention.',
  summary:
    'A dashboard for every project — active tasks, multi-cloud node health, and filterable notifications.',
  highlights: [
    'Active tasks across every project, with status and timing at a glance',
    'Node health with CPU, memory, and disk usage per machine, across every connected provider',
    'Notifications filtered by type — errors, completions, progress, and decision points',
  ],
  docsHref: '/docs/guides/notifications/',
  group: 'run',
  screenshots: [
    {
      src: '/images/features/dashboard.png',
      alt: 'Dashboard with Active Tasks cards showing status, project name, and timing, plus a Projects grid with workspace and session counts',
      caption: 'Active tasks across projects, with status and timing at a glance',
    },
  ],
  details: [
    {
      headline: 'Multi-project dashboard',
      body: 'See active tasks with their status, project, and timing. Below that, a project grid shows workspace counts, session counts, and last activity for each repo.',
      screenshot: {
        src: '/images/features/dashboard.png',
        alt: 'Dashboard with In Progress task cards and a Projects grid showing workspace and session counts per repo',
        caption: 'Active tasks at the top, all projects below — click any card to jump in',
      },
    },
    {
      headline: 'Infrastructure you can see, across every cloud',
      body: 'Each node card shows its provider, spec, pricing, CPU/memory/disk usage, and the workspaces running on it — whether it is on Hetzner, Scaleway, Vultr, or any other connected provider. Create new nodes or add workspaces from the same page.',
      screenshot: {
        src: '/images/features/sam-nodes-multi-provider.png',
        alt: 'Nodes page listing Hetzner, Scaleway, and Vultr machines side by side with status, health, observed and configured hardware, offering price, CPU, memory, and disk usage, and the workspaces on each',
        caption: 'Node specs, real-time resource usage, and workspace allocation across providers',
      },
    },
    {
      headline: 'Never miss a decision point',
      body: 'Notifications are categorized by type — task completions, errors, progress updates, sessions ended, PRs created, and moments where agents need human input. Filter to focus on what matters.',
      screenshot: {
        src: '/images/features/notifications.png',
        alt: 'Notification feed with filter tabs: All, Task Complete, Needs Input, Error, Progress, Session Ended, PR Created',
        caption: 'Filter by type — Task Complete, Needs Input, Error, Progress, and more',
      },
    },
  ],
};
