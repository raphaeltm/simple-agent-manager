import type { FeatureSection } from './types';

export const chatSection: FeatureSection = {
  slug: 'chat',
  label: 'Chat-First Development',
  title: 'Describe what you want.\nWatch it happen.',
  subtitle:
    'Talk to your agents like teammates. Pick the right model for the job, attach files, and watch them write code, run tests, and open PRs — all from a single chat.',
  summary:
    'Talk to your agents like teammates — pick a profile, describe the task, and watch every tool call stream live.',
  highlights: [
    'Switch between Claude Code, Codex, Gemini CLI, Mistral Vibe, OpenCode, and Amp without leaving the chat',
    'Every tool call, shell command, and file edit streams live, with a cancel button',
    'Session header chips surface comments, infrastructure, and task status at a glance',
    'Pick the agent profile that fits the task, not a one-size-fits-all default',
  ],
  docsHref: '/docs/guides/chat-features/',
  group: 'run',
  screenshots: [
    {
      src: '/images/features/sam-hero-live-session.png',
      alt: 'A busy SAM project chat showing a user prompt, the agent’s plan, grouped tool calls, header chips for comments, infrastructure, and task status, a profile bar, and a session sidebar with several topics',
      caption:
        'A live project chat — plan, tool calls, comments, infrastructure, and task status in one view',
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
        caption:
          'Every MCP tool call, shell command, and file edit — streamed live with the ability to cancel',
      },
    },
  ],
};
