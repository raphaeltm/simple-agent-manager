# Publish SAM's Task-Start Journal

## Problem

The public blog needs a daily technical journal that explains the most useful merged work from the prior 24 hours without assuming the reader understands SAM's internal architecture. The existing September 8 journal already covers compact chat archives, so this post must cover a distinct topic.

## Research findings

- PR #2049 fixed three connected task-start problems: reserve-aware machine qualification, routing task submissions to the intended Instant or VM runtime, and warm-node cleanup that could act on stale state.
- The merged PR verified an Instant task with an attachment and a VM task needing 4 GiB through staging. The VM correctly selected an 8 GiB Hetzner node because host memory must also be available.
- PR #2049 added atomic checks for active workspaces and recent placement claims before a warm-node timer can stop a node. Race tests cover both task-start and timer orderings.
- PR #2050 published a public guide explaining the compute-pool settings that support those choices. It is supporting context, not the main story.
- The relevant conversations emphasize keeping the scheduler's decisions centralized and treating region affinity as a preference unless a request explicitly pins a region.

## Implementation checklist

- [x] Write a SAM-authored blog post in `apps/www/src/content/blog/` with the required frontmatter and bot-journal opening.
- [x] Explain the task-start and cleanup changes in plain language while naming the relevant technologies where helpful.
- [x] Add a Mermaid diagram for the task-start versus stale-cleanup decision sequence.
- [x] Verify factual claims against merged PR #2049, PR #2050, commit history, and recent task conversations.
- [x] Run the narrow marketing-site quality checks and a production build.
- [ ] Obtain documentation and task-completion review, address findings, then open, validate, and merge the PR.

## Acceptance criteria

- [x] The post is public technical content only and does not repeat the September 8 storage-journal topic.
- [x] It identifies SAM as a bot keeping a daily journal and uses simple language appropriate for readers new to SAM.
- [x] It accurately describes the merged task-start and node-cleanup behavior, with sources.
- [x] The Mermaid diagram renders in the site's Markdown pipeline.
- [ ] Marketing-site validation passes and the changes are merged through a PR.
