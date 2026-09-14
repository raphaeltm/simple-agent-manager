import type { FeatureSection } from './types';

export const eventsSection: FeatureSection = {
  slug: 'events',
  label: 'Event Streams & Triggers',
  title: 'Automation your team\ncan see.',
  subtitle:
    'Cron schedules, GitHub events, authenticated webhooks, and platform incidents all start work through one trigger system — with delivery history, one-off schedules, standing watches, and an activity stream of everything that happened.',
  summary:
    'Cron, GitHub, and webhook triggers, plus one-off schedules, standing watches, and channels for agents.',
  highlights: [
    'Four trigger sources: cron schedules, GitHub events, authenticated JSON webhooks, and platform incidents',
    'Webhook triggers get a per-trigger bearer token, payload filters, safe headers, and a prompt template',
    'Delivery history records every attempt — accepted, filtered, duplicate, or held back — with HTTP status and size',
    'One-off schedules message a session or start a new one at a set time; standing watches run a filter → action policy with cooldown and concurrency limits',
    'Agent event subscriptions and an activity stream cover everything that happened across the project',
  ],
  docsHref: '/docs/guides/scheduled-actions/',
  group: 'automate',
  screenshots: [
    {
      src: '/images/features/sam-triggers-sources.png',
      alt: 'Triggers page listing cron, GitHub, and webhook triggers with their status, schedule, last and next run times, and a personal-credential attribution warning on one trigger',
      caption: 'Every trigger source in one list, with its schedule and who is paying for it',
    },
    {
      src: '/images/features/sam-webhook-deliveries.png',
      alt: 'Webhook trigger detail showing the active token’s last four characters with a Rotate token button, a payload preview, and a delivery history with Accepted, Filtered, Duplicate, Still Running, and Concurrent Limit outcomes',
      caption: 'A full audit trail for every webhook delivery — accepted, filtered, duplicate, or held back',
    },
    {
      src: '/images/features/sam-events-subscriptions.png',
      alt: 'Events page listing agent event subscriptions, each showing its source and event type, the requested delivery mode next to the resolved delivery mode, expiry, last match, and Inspect delivery and Cancel subscription controls',
      caption: 'Agents subscribe to project events and get them injected into context',
    },
    {
      src: '/images/features/sam-activity-stream.png',
      alt: 'Project activity stream listing events across triggers, schedules, watches, and sessions',
      caption: 'One activity stream records everything that happened across the project',
    },
  ],
  details: [
    {
      headline: 'Four ways to start work',
      body: 'Triggers fire from cron schedules, GitHub issues, comments, pull requests, and pushes, authenticated JSON webhooks, or platform incidents. Each trigger shows its status, schedule, and last and next run, and flags when it is running on someone’s personal credential.',
      screenshot: {
        src: '/images/features/sam-triggers-sources.png',
        alt: 'Triggers page listing cron, GitHub, and webhook triggers with their status, schedule, last and next run times, and a personal-credential attribution warning on one trigger',
        caption: 'Every trigger source in one list, with its schedule and who is paying for it',
      },
    },
    {
      headline: 'Webhooks with a real audit trail',
      body: 'A webhook trigger gets a per-trigger bearer token (shown once, prefixed sam_wh_), payload filters, a prompt template, and a set of safe request headers. Delivery history records every attempt — accepted, filtered, duplicate, still running, or over the concurrency limit — and idempotency keys keep retries safe.',
      screenshot: {
        src: '/images/features/sam-webhook-deliveries.png',
        alt: 'Webhook trigger detail showing the active token’s last four characters with a Rotate token button, a payload preview, and a delivery history with Accepted, Filtered, Duplicate, Still Running, and Concurrent Limit outcomes',
        caption: 'A full audit trail for every webhook delivery — accepted, filtered, duplicate, or held back',
      },
    },
    {
      headline: 'Agents subscribe too',
      body: 'Agents subscribe to project events and get them injected into context, or wake a sleeping session. Subscriptions show both requested and resolved delivery, so a match is never assumed to have reached the agent.',
      screenshot: {
        src: '/images/features/sam-events-subscriptions.png',
        alt: 'Events page listing agent event subscriptions, each showing its source and event type, the requested delivery mode next to the resolved delivery mode, expiry, last match, and Inspect delivery and Cancel subscription controls',
        caption: 'Agents subscribe to project events and get them injected into context',
      },
    },
    {
      headline: 'Schedules, standing watches, and channels',
      body: 'Schedule once to message an existing session or start a new one at a set time. A standing watch is a human-managed policy — filter, action, cooldown, concurrency, and a finite execution limit — that keeps running until you pause or revoke it. Event channels give collaborating agents a bounded shared history with a catch-up-to-follow handoff, and an activity stream records everything that happened.',
      screenshot: {
        src: '/images/features/sam-events-watches.png',
        alt: 'Standing watches page showing an active watch that starts a new session when a CI check suite fails, with 7 of 20 executions used, one concurrent run, and a 30 minute cooldown, plus a paused watch on security-labelled issues',
        caption: 'A standing watch: filter, action, cooldown, concurrency, and a finite execution limit',
      },
    },
  ],
};
