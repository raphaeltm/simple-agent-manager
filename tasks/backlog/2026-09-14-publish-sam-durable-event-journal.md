# Publish SAM's durable event journal

## Problem

Publish a public daily technical journal about meaningful SAM changes from the
last 24 hours. The post must be written by SAM as a bot, explain the work to a
reader unfamiliar with SAM, and cover only features, technology, and code.

## Research findings

- PR #2075 introduced durable project events, schedules, subscriptions, and
  project channels. The system records an event before trying to wake an agent,
  so a short-lived delivery failure does not erase the event.
- PR #2076 enabled project-event wake delivery.
- PR #2077 made `interrupt`-class durable messages act on their stated urgency:
  when the target agent is busy, SAM uses authoritative busy evidence from its
  VM host, stops the in-flight turn, and delivers the message as the next turn.
  Ordinary `notify` and `deliver` messages continue to wait.
- The implementation task recorded staging evidence: an interrupt-class message
  reached the next agent turn in about 15 seconds, while a normal delivery
  waited for the existing turn to end without interrupting it.
- `apps/www/src/content/CLAUDE.md` requires complete frontmatter, a clear
  opening, accurate technical claims, a local preview/build, and a useful
  developer-facing structure. `apps/www/AGENTS.md` confirms that Mermaid fences
  are rendered client-side. The Mermaid browser regression matrix should cover
  this new diagram.
- Existing journals use the required opening: "I'm SAM. I'm a bot, keeping a
  daily journal of what I've been up to in this codebase." The new post must
  retain the daily-journal framing and use plain language for architecture.

## Implementation checklist

- [ ] Add a SAM-authored `devlog` post in `apps/www/src/content/blog/` with
  required frontmatter and the established bot-journal framing.
- [ ] Explain durable events, wake delivery, normal messages, and urgent
  messages in short, layperson-friendly sections.
- [ ] Add a Mermaid sequence diagram because the queue-to-Durable-Object-to-VM
  delivery flow is easier to understand visually.
- [ ] Add the post to the Mermaid browser regression matrix.
- [ ] Run narrow marketing-site lint, typecheck, test, build, link checks, and
  Mermaid browser validation.
- [ ] Run documentation and task-completion review, then archive this task
  file.

## Acceptance criteria

- [ ] The post identifies SAM as a bot keeping a daily journal and includes
  only feature, technology, or code content.
- [ ] A reader unfamiliar with SAM can understand why recording an event before
  delivery matters, and why an urgent message differs from an ordinary one.
- [ ] The Mermaid diagram renders, supports its controls, and has no horizontal
  overflow in the targeted browser test.
- [ ] Narrow marketing-site validation and specialist reviews pass.
