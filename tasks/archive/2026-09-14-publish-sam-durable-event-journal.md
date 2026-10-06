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

- [x] Add a SAM-authored `devlog` post in `apps/www/src/content/blog/` with
  required frontmatter and the established bot-journal framing.
- [x] Explain durable events, wake delivery, normal messages, and urgent
  messages in short, layperson-friendly sections.
- [x] Add a Mermaid sequence diagram because the queue-to-Durable-Object-to-VM
  delivery flow is easier to understand visually.
- [x] Add the post to the Mermaid browser regression matrix.
- [x] Run narrow marketing-site lint, typecheck, test, build, link checks, and
  Mermaid browser validation.
- [x] Run documentation and task-completion review, then archive this task
  file.

## Validation evidence

| Check | Result |
| --- | --- |
| `pnpm typecheck && pnpm lint` | PASS; six pre-existing warnings, no errors |
| `pnpm --filter @simple-agent-manager/www lint` | PASS |
| `pnpm --filter @simple-agent-manager/www typecheck` | PASS with five existing Astro-template errors and no new warnings |
| `pnpm --filter @simple-agent-manager/www test` | PASS; 49 tests |
| `pnpm --filter @simple-agent-manager/www build` | PASS |
| `pnpm --filter @simple-agent-manager/www check:links` | PASS; 0 broken internal links |
| `pnpm exec playwright test tests/playwright/blog-mermaid.spec.ts --project='Desktop Chrome' --grep='durable event journal'` | PASS; rendered diagram, controls, and no-overflow assertion |
| Visual review | PASS; reviewed the generated full-page desktop screenshot |

## Specialist review evidence

| Review | Result |
| --- | --- |
| Documentation sync | PASS; public claims, PR links, and Mermaid usage match the merged implementation and public architecture docs |
| Test engineering | PASS; the real-page browser test covers rendering, zoom/reset, full screen, overflow, and screenshots |
| Task completion | PASS after the validation-evidence and specialist-review records were added; final report follows this commit |

## Acceptance criteria

- [x] The post identifies SAM as a bot keeping a daily journal and includes
  only feature, technology, or code content.
- [x] A reader unfamiliar with SAM can understand why recording an event before
  delivery matters, and why an urgent message differs from an ordinary one.
- [x] The Mermaid diagram renders, supports its controls, and has no horizontal
  overflow in the targeted browser test.
- [x] Narrow marketing-site validation and specialist reviews pass.
