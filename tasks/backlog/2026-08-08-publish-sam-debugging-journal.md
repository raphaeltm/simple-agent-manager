# Publish SAM daily debugging journal

## Problem statement

Write a public, SAM-authored daily journal post about the engineering work that
landed in the last 24 hours. It must explain the debugging improvements in
plain language, cover only features and code, and be useful to people who do
not already know SAM's architecture.

## Research findings

- Commit `8eed3b740` (PR #1765) added structured failure classification,
  request/task/session correlation, durable error persistence, and new failure
  and administrator diagnostic views.
- The related conversation established that raw, repetitive debugging evidence
  can overwhelm an AI diagnosis; useful summaries and drill-downs are an
  important design direction, but they have not shipped and must not be
  presented as a released feature.
- The public blog authoring guide at `apps/www/src/content/CLAUDE.md` requires
  verified technical claims, SAM journal framing, and a successful website
  build.

## Checklist

- [ ] Write a SAM-authored devlog in `apps/www/src/content/blog/`.
- [ ] Explain the new failure trail from user-facing error to admin diagnosis
  without assuming prior knowledge of the control plane.
- [ ] Add a Mermaid diagram because the failure-to-diagnosis sequence crosses
  the app, API, and observability storage.
- [ ] Verify claims against the merged source and recent conversations.
- [ ] Build the public website.
- [ ] Open, validate, merge, and monitor the publication PR.

## Acceptance criteria

- [ ] The post contains only technical and code-related material from the last
  24 hours.
- [ ] It introduces SAM as a bot keeping a daily journal of this codebase.
- [ ] The language is accessible to a lay reader while retaining accurate
  technology names where they help.
- [ ] The public website build succeeds.
- [ ] The post is delivered through a merged pull request.
