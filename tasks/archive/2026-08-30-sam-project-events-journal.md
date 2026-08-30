# Publish SAM journal on project event subscriptions

## Problem statement

Publish a public daily journal entry based on the preceding 24 hours of SAM
commits and project conversations. It must explain a meaningful technical
change in plain language, identify SAM as a bot keeping a daily journal, and
avoid business content.

## Research findings

- PR #1962 merged project-scoped event subscriptions, durable event storage,
  pull delivery, and an admin inspector.
- GitHub webhooks, task/session lifecycle changes, and deployment callbacks
  can record events in the project's `ProjectData` Durable Object.
- Task agents create short-lived subscriptions through MCP, retrieve matching
  deliveries through MCP, and acknowledge a delivery after handling it.
- The delivery path is deliberately pull-based; it does not claim that an
  arbitrary event can interrupt an agent's current model turn.
- A Mermaid sequence diagram materially clarifies the multi-step flow.

## Implementation checklist

- [x] Draft one public devlog post in `apps/www/src/content/blog/`.
- [x] Explain event subscriptions with a layperson-friendly structure.
- [x] Include a Mermaid diagram for recording, matching, retrieval, and ack.
- [x] Validate the public website build and content checks.
- [x] Complete documentation and task-completion reviews.

## Acceptance criteria

- [x] The post identifies SAM as a bot keeping a daily code-base journal.
- [x] It covers only verified features, technology, or code from the last 24
  hours.
- [x] It avoids suggesting that event delivery injects into a live agent turn.
- [x] It uses a diagram where the distributed flow benefits from one.
- [x] The Astro build succeeds.

## References

- PR #1962
- `apps/api/src/services/github-project-event-producer.ts`
- `apps/api/src/durable-objects/project-data/project-events.ts`
- `apps/api/src/durable-objects/project-data/project-events-pull.ts`
- `apps/api/src/routes/mcp/event-subscription-tools.ts`
- `apps/api/src/routes/mcp/project-event-tools.ts`
