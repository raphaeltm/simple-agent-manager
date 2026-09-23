# SAM daily journal — resource history

Status: completed

## Problem

Publish a public SAM daily technical journal entry based on the code and
conversations from the preceding 24 hours. It must explain a meaningful shipped
feature in simple language for readers who do not already understand SAM's
architecture. It must discuss only code, features, or technology.

## Research findings

- Merged PR #2110 adds per-workspace resource history, including cgroup-v2
  sampling in the VM agent, bounded local buffering, compressed R2 chunks, D1
  indexes and summaries, authorized APIs/MCP access, and a contextual Resources
  drawer.
- The feature captures sanitized tool windows for correlation only. It stores
  timing, kind, a hashed tool identifier, and concurrency; prompts, arguments,
  outputs, commands, file paths, and environment values are excluded.
- Its VM-to-storage-to-reader path crosses several system boundaries. A Mermaid
  diagram will make that flow clearer than prose alone.
- The post belongs in `apps/www/src/content/blog/`, using the established daily
  journal voice and the `devlog` category. The marketing-site authoring guide
  requires frontmatter, a sub-60-character title, a sub-160-character excerpt,
  accurate technical claims, and a marketing-site build before publishing.

## Implementation checklist

- [x] Verify all resource-history claims against the implementation and delivery evidence.
- [x] Write the journal post in SAM's voice with plain-language structure.
- [x] Add a Mermaid flow diagram for the collector, retained data, and reader path.
- [x] Run the narrow marketing-site validation and inspect the built page.
- [x] Run documentation and task-completion reviews; address findings.
- [x] Create, validate, review, merge, and monitor the PR.

## Acceptance criteria

- [x] The published entry begins as SAM's daily technical journal and discusses only code, features, or technology.
- [x] It explains the shipped resource-history feature accurately enough for a lay reader without assuming architectural knowledge.
- [x] It describes collection, retention, and reading boundaries without exposing sensitive data or overstating tool correlation.
- [x] It includes a Mermaid diagram because the distributed data flow is central to the explanation.
- [x] The marketing site builds successfully and the published page renders correctly.
- [x] The change has a reviewed, merged PR and the production deployment succeeds.

## Completion evidence

- PR #2111 merged as `8f35f823ce70ba236990d1f7391b7d40dbdc3d71`.
- CodeRabbit's sole finding added direct cgroup-v2, R2, and D1 documentation links; the fix passed lint, build, and the focused desktop/mobile Mermaid test.
- The `Deploy Marketing Site` run `35521271708` completed successfully.

## References

- PR #2110 and commit `c97d00ec093e43ec2209bd5a408bdefa8e0ac6a1`
- `tasks/archive/2026-09-20-workspace-resource-history.md`
- `packages/vm-agent/internal/resourcehistory/collector.go`
- `apps/api/src/services/workspace-resource-history.ts`
- `apps/www/src/content/CLAUDE.md`
