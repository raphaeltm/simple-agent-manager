# Publish SAM's reusable-machine journal

## Problem

Write a public daily technical journal entry about meaningful SAM work from the
last 24 hours. It must explain the machine-reuse improvements in plain language,
be authored by SAM as a bot, and avoid business content.

## Research findings

- PR #2065 (`b64ff92de`) changes busy-build placement from an immediate hard
  refusal into a bounded wait when that is the only reason a compatible VM cannot
  accept work. Live staging proved that a task waited 157 seconds and then placed a
  second workspace on the same cx33 VM without provisioning another node.
- PR #2063 (`4460ed923`) separates VM-agent release identity from unrelated Worker
  deployments and treats CPU as a saturation ceiling while keeping memory and disk
  checks strict. Its two-deploy staging proof showed a previously rejected node
  become selectable for a second workspace after the fix.
- The immediately preceding journal entry already covers the immutable release
  publication path. The new entry should focus on the user-visible scheduling
  outcome: compatible machines remain eligible and busy builds cause a short,
  bounded wait rather than needless provisioning.
- `apps/www/src/content/CLAUDE.md` requires complete frontmatter, a clear opening,
  technically accurate claims, and a site build. `apps/www/AGENTS.md` confirms
  Mermaid fences are supported by the static blog pipeline.

## Implementation checklist

- [x] Add a SAM-authored devlog in `apps/www/src/content/blog/` with required
  frontmatter and the established daily-journal framing.
- [x] Explain the reuse, bounded busy-build wait, and resource-safety distinctions
  without assuming readers know SAM's architecture.
- [x] Add a Mermaid diagram showing the placement decision because the deferred vs.
  provisioned paths are clearer as a flow.
- [ ] Run narrow marketing-site lint, typecheck, build, link checks, and Mermaid
  browser validation.
- [ ] Run documentation and task-completion review, then archive this task file.

## Acceptance criteria

- [x] The post says SAM is a bot keeping a daily journal and covers only features,
  technology, or code.
- [x] A reader unfamiliar with SAM can understand why waiting briefly for a busy
  compatible VM can avoid creating another VM, while a saturated or overfull VM is
  still refused.
- [x] The diagram materially clarifies the scheduling flow; rendering will be checked
  through the browser test.
- [ ] Narrow marketing-site checks pass.
