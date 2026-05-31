export interface FeatureScreenshot {
  src: string;
  alt: string;
  caption: string;
}

export interface FeatureSection {
  slug: string;
  label: string;
  title: string;
  subtitle: string;
  screenshots: FeatureScreenshot[];
  details: {
    headline: string;
    body: string;
    screenshot: FeatureScreenshot;
  }[];
}

export const featureSections: FeatureSection[] = [
  {
    slug: 'chat',
    label: 'Chat-First Development',
    title: 'Describe what you want.\nWatch it happen.',
    subtitle:
      'Talk to your agents like teammates. Pick the right model for the job, attach files, and watch them write code, run tests, and open PRs — all from a single chat.',
    screenshots: [
      {
        src: '/images/features/project-chat.png',
        alt: 'Project chat interface with agent selector showing Brainstormer, Codex, Opus, and other profiles, plus quick-start prompt suggestions',
        caption: 'Pick an agent profile, describe the task, and start a session',
      },
      {
        src: '/images/features/live-session.png',
        alt: 'Live agent session showing MCP tool calls, shell commands, file edits, and a cancel button while the agent works',
        caption: 'Watch tool calls, shell commands, and file edits stream in real time',
      },
    ],
    details: [
      {
        headline: 'Multiple agents, one interface',
        body: 'Switch between Claude Code, Codex, Gemini CLI, Amp, and more — each configured with their own API key or OAuth token. Choose the right agent for the task without leaving the chat.',
        screenshot: {
          src: '/images/features/project-chat.png',
          alt: 'Project chat with agent selector bar showing Brainstormer, Codex 5.5 Chat, Opus 4.6 Chat, Picky CTO, and more profiles',
          caption: 'Agent profiles listed at the bottom of the chat — click to switch',
        },
      },
      {
        headline: 'Real-time visibility into agent work',
        body: 'Tool calls, file edits, and shell commands are streamed to your browser as they happen. You can read every step the agent takes and cancel at any time.',
        screenshot: {
          src: '/images/features/live-session.png',
          alt: 'Live chat session showing MCP tool calls, shell commands with output, file edits, and a cancel button',
          caption: 'Every MCP tool call, shell command, and file edit — streamed live with the ability to cancel',
        },
      },
    ],
  },
  {
    slug: 'visibility',
    label: 'Full Visibility & Control',
    title: 'See everything.\nStay in control.',
    subtitle:
      'A dashboard for all your agent work. Track active tasks across projects, monitor node health, and get notified when agents need your attention.',
    screenshots: [
      {
        src: '/images/features/dashboard.png',
        alt: 'Dashboard with Active Tasks cards showing status, project name, and timing, plus a Projects grid with workspace and session counts',
        caption: 'Active tasks across projects, with status and timing at a glance',
      },
      {
        src: '/images/features/nodes.png',
        alt: 'Nodes page showing three Hetzner VMs with Running/Healthy status, CPU/MEM/DISK percentages, specs, pricing, and workspace lists',
        caption: 'Node health with CPU, memory, and disk stats per VM',
      },
      {
        src: '/images/features/notifications.png',
        alt: 'Notification feed with filter tabs for All, Task Complete, Needs Input, Error, Progress, Session Ended, and PR Created',
        caption: 'Filterable notifications — errors, completions, progress, and decision points',
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
        headline: 'Infrastructure you can see',
        body: 'Each node card shows its provider, spec, pricing, CPU/memory/disk usage, and the workspaces running on it. Create new nodes or add workspaces from the same page.',
        screenshot: {
          src: '/images/features/nodes.png',
          alt: 'Three Hetzner cx43 nodes showing Running/Healthy status, resource percentages, and their workspace lists',
          caption: 'Node specs, real-time resource usage, and workspace allocation',
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
  },
  {
    slug: 'agent-context',
    label: 'Agents That Learn',
    title: 'Agents that remember\nyour preferences.',
    subtitle:
      'Build a project knowledge base that agents receive as context. Set policies that are injected into every session. Review a full log of agent activity.',
    screenshots: [
      {
        src: '/images/features/agent-context-overview.png',
        alt: 'Agent context overview showing memory entities (25), active policies (12), recent actions (50), and the context stack agents receive',
        caption: 'Overview of the context stack — repo instructions, memory, policies, and profiles',
      },
      {
        src: '/images/features/agent-memory.png',
        alt: 'Agent memory tab with architecture observations, each showing a confidence score (92–95%), source type, and confirmation date',
        caption: 'Project knowledge with confidence scores and source tracking',
      },
      {
        src: '/images/features/agent-policies.png',
        alt: 'Agent policies tab showing preference and rule entries like scrolling wrapper handling and Go QA standards, marked instruction-only',
        caption: 'Project policies injected into agent sessions as instructions',
      },
      {
        src: '/images/features/agent-actions.png',
        alt: 'Agent actions feed with event types like task.agent_completed, task.execution_step, session.started, and timestamps',
        caption: 'Activity log of every task, session, and execution event',
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
          caption: 'Policies are instruction-only — injected into agent context, not programmatically enforced',
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
  },
  {
    slug: 'automation',
    label: 'Idea to Execution',
    title: 'From idea to\nagent-ready task.',
    subtitle:
      'Capture ideas with a problem statement and plan. Schedule recurring tasks on a weekly or daily cadence. When you are ready, dispatch an agent with one click.',
    screenshots: [
      {
        src: '/images/features/ideas.png',
        alt: 'Idea detail page showing a problem description, phased implementation plan, Execute button, and a linked conversations sidebar',
        caption: 'Structured ideas with problem, plan, and an Execute button to dispatch an agent',
      },
      {
        src: '/images/features/triggers.png',
        alt: 'Triggers page with four scheduled tasks — Workspace Update, Spot Check, Bi-Weekly Dependabot Merge, Weekly website claims audit — showing run/pause controls and timing',
        caption: 'Recurring schedules with run, pause, resume controls and run history',
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
        headline: 'Recurring triggers',
        body: 'Schedule agents to run dependency updates, spot checks, audits, or other recurring work on a daily or weekly cadence. Pause, resume, or run manually any time.',
        screenshot: {
          src: '/images/features/triggers.png',
          alt: 'Four triggers with schedules like "At 12:00 PM on Tuesday" and "At 4:00 AM on Monday, Wed..." plus Run Now, Pause, Resume, and View History buttons',
          caption: 'Each trigger shows its schedule, last run, next run, and status — with manual run and pause controls',
        },
      },
    ],
  },
  {
    slug: 'configuration',
    label: 'Your Project, Your Way',
    title: 'Fully configurable.\nOpen source.',
    subtitle:
      'Upload reference docs, choose your VM size, and pick a default agent — each project has its own settings for infrastructure and agent configuration.',
    screenshots: [
      {
        src: '/images/features/library.png',
        alt: 'Library file browser showing a research folder, an uploaded markdown file with tags (architecture, missions, orchestration), and an Upload button',
        caption: 'File browser with folders, tags, sorting, and upload',
      },
      {
        src: '/images/features/document-viewer.png',
        alt: 'Document viewer rendering a markdown file with a Mermaid architecture diagram, plus Rendered/Source/Download toggle buttons',
        caption: 'Rendered markdown with Mermaid diagrams — toggle between rendered view and source',
      },
      {
        src: '/images/features/settings.png',
        alt: 'Project settings with three node sizes (Small/Medium/Large with specs and pricing) and six agent types (Claude Code, Codex, Gemini CLI, Mistral Vibe, OpenCode, Amp)',
        caption: 'Choose a default node size and agent type per project',
      },
    ],
    details: [
      {
        headline: 'Project library',
        body: 'Upload architecture docs, research, and reference material. Files are organized with folders and tags. Agents can access library files as additional context during their work.',
        screenshot: {
          src: '/images/features/library.png',
          alt: 'Library showing a research folder with 1 subfolder and 1 tagged markdown file, plus filter, folder, and upload controls',
          caption: 'Folders, tags, and upload — agents can pull files from the library as context',
        },
      },
      {
        headline: 'Built-in document viewer',
        body: 'Markdown files render with full formatting, including Mermaid diagrams. Toggle between the rendered view and raw source, or download the file directly.',
        screenshot: {
          src: '/images/features/document-viewer.png',
          alt: 'Document viewer showing a rendered markdown file with a Mermaid architecture flowchart and Rendered/Source/Download buttons',
          caption: 'Rendered markdown with Mermaid diagram support — view source or download',
        },
      },
      {
        headline: 'Infrastructure and agent defaults',
        body: 'Choose a default node size (Small, Medium, or Large with specs and pricing shown) and a default agent type for each project. Per-agent credential overrides let you configure API keys at the project level.',
        screenshot: {
          src: '/images/features/settings.png',
          alt: 'Settings page with three node sizes showing vCPU/RAM/storage/price, six agent types, and per-agent credential configuration',
          caption: 'Node sizing, agent selection, and per-agent credential overrides — all per project',
        },
      },
    ],
  },
];
