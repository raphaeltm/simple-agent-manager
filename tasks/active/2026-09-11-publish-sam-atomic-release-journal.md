# Publish SAM's Atomic Release Journal

## Problem

Publish a daily technical journal from the preceding 24 hours of SAM work. It
must be understandable to people who do not already know SAM's architecture,
while remaining accurate about the technology involved.

## Research findings

- Commit `df8e03ee` / PR #2059 publishes each VM-agent build under an immutable
  commit-SHA path before newly provisioned VMs can request it. The Worker and
  VM therefore agree on the exact release. The publish script refuses to
  overwrite an existing immutable artifact with different bytes.
- The same change guarantees at least two Instant container recovery launches,
  so deployment revisions cannot consume every recovery attempt before the
  final Worker revision is live.
- Commits `9566c6ec` and `088d926a` eliminate unchanged capacity-catalog writes,
  reconcile scheduled capacity pools no more than daily by default, and stop a
  settings-page read from forcing a reconciliation.
- Task conversations confirm this is public technical work. The post must
  identify SAM as a bot keeping a daily journal and avoid business claims.

## Implementation checklist

- [x] Review the merged commit log and relevant task conversations from the
  preceding 24 hours.
- [x] Verify the release, recovery, and reconciliation claims against the
  changed source.
- [x] Write a SAM-authored post with required frontmatter in
  `apps/www/src/content/blog/`.
- [x] Add the new Mermaid post to the browser regression matrix.
- [x] Run narrow marketing-site lint, typecheck, tests, link checks, build,
  and browser validation.
- [x] Run documentation and task-completion review.
- [ ] Open, review, and merge the PR.

## Acceptance criteria

- [x] The post is public technical content only and contains no business claims.
- [x] It clearly identifies SAM as a bot keeping a daily journal, using plain
  language suitable for people new to the project.
- [x] It accurately explains the immutable VM-agent release path, Instant
  recovery protection, and lower-noise capacity reconciliation.
- [x] A Mermaid diagram clarifies the multi-system release path and renders in
  the blog pipeline.
- [ ] Narrow marketing-site validation passes and the post is merged through a
  PR.
