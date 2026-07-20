# Daily SAM journal: runtime routing and cleanup

## Problem statement

Write and publish a daily SAM journal post based on public technical work from the last 24 hours. The post must be written on SAM's behalf, use Raphaël's established journal tone, explain the architecture plainly for readers who do not know SAM, and avoid business/strategy material.

If the last 24 hours do not contain generally interesting technical work, publish nothing.

## Research findings

- Recent commits show three publishable technical threads:
  - `9e0fa384e` / PR #1618: expired-trial cleanup now treats conclusively absent provider VMs as an idempotent cleanup outcome instead of retrying forever.
  - `c8ef32352` / PR #1643: MCP `dispatch_task` now respects runtime routing and can launch explicit `cf-container` profiles through the Instant session path instead of always starting a VM TaskRunner.
  - `a06273483` / PR #1644: the static supported-agent model catalog was refreshed from authoritative provider sources and tests were updated.
- Relevant task records:
  - `tasks/archive/2026-07-17-stop-expired-trial-missing-vm-retries.md`
  - `tasks/archive/2026-07-20-fix-dispatch-task-runtime-routing.md`
  - `tasks/archive/2026-07-20-update-hardcoded-model-catalog.md`
- Existing SAM journal posts live under `apps/www/src/content/blog/` and use `author: SAM`, `category: devlog`, and a first paragraph that says SAM is a bot keeping a daily journal.
- `apps/www/src/content/CLAUDE.md` defines frontmatter, tone, tags, and build validation requirements.

## Implementation checklist

- [ ] Create a new SAM journal markdown post under `apps/www/src/content/blog/`.
- [ ] Keep the post focused on features, tech, and code.
- [ ] Explain runtime routing, VM cleanup, and model catalog maintenance in simple structure with precise technical terms.
- [ ] Include a Mermaid diagram only if it materially clarifies the runtime routing flow.
- [ ] Validate the content build.
- [ ] Archive this task record.
- [ ] Create, merge, and monitor the PR.

## Acceptance criteria

- The blog post has valid frontmatter and follows the existing SAM journal pattern.
- The post is understandable without prior SAM architecture knowledge.
- Technical claims are grounded in the commit log, conversation snippets, task records, and changed files.
- No business, strategy, or unsupported claims are included.
- The branch is pushed, PR is created and merged, and production deployment is monitored.
