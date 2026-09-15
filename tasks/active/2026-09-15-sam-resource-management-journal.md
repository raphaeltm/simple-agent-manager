# Publish SAM's resource-management journal entry

## Problem

The public blog needs a daily technical journal entry that explains the most
meaningful work merged during the preceding 24 hours. The post must be written
by SAM, for readers who do not already know SAM's architecture. It may only
cover features, technology, and code.

## Research findings

- Commit `5b997315` merged PR #1980 on 2026-09-15. It combines cgroup resource
  isolation, active VM resource monitoring, pre-stop snapshots, eviction, and
  explicit restart handling.
- The implementation records Linux memory pressure (PSI), Docker OOM events,
  and per-container resource statistics. Under sustained pressure, it captures
  recoverable workspace state before stopping the affected container.
- `tasks/evidence/2026-09-13-vm-resource-management/verification.md` records a
  real staging VM verification: Docker OOM eviction, a healthy host afterward,
  an explicit restart, and successful recovery of a sentinel file.
- Conversations for the resource-management work confirm the intended boundary:
  infrastructure services are protected with cgroups, affected workspaces are
  monitored, and automatic rescheduling is deliberately outside this feature.
- `apps/www/src/content/CLAUDE.md` requires MD frontmatter, an accurate
  technical account, a concise title and excerpt, and a local production build.

## Implementation checklist

- [ ] Add a blog post under `apps/www/src/content/blog/` with SAM as author and
  first-person daily-journal framing.
- [ ] Explain the protection, observation, snapshot, eviction, and explicit
  restart flow in language accessible to a reader new to SAM.
- [ ] Include a Mermaid diagram of the resource-pressure lifecycle because the
  VM-agent, workspace, API, and browser responsibility boundaries are easier
  to understand visually.
- [ ] Confirm technical claims against source material and avoid claims about
  automatic rescheduling.
- [ ] Build the public website and verify the published blog route locally.

## Acceptance criteria

- The post is a publicly published (non-draft) blog entry authored by SAM.
- It begins with the requested bot-journal framing and only discusses code and
  technical features.
- Readers can understand the high-level change without prior SAM knowledge.
- Technical terms such as cgroups, PSI, and Docker OOM events are explained in
  place.
- The production website build succeeds and the post's Mermaid diagram renders.

## References

- `5b997315de37aa8ff7b182303d73b5f9a76591f2`
- `tasks/evidence/2026-09-13-vm-resource-management/verification.md`
- `apps/www/src/content/CLAUDE.md`
- `apps/www/AGENTS.md`
