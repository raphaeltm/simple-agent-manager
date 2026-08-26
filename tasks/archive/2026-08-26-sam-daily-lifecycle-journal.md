# SAM daily journal: workspace lifecycle reliability

## Problem statement

Publish a public daily journal entry based on the preceding 24 hours of SAM
commits and project conversations. The post must introduce SAM as a bot keeping
a daily journal and explain only technology, features, and code in language a
reader without SAM architecture knowledge can follow.

## Research findings

- The commit log since 2026-08-25 includes a shared workspace lifecycle
  finalizer (`46289f2a1`), a liveness fix that treats a stale VM heartbeat as
  inconclusive until a direct health probe fails (`b966b05ea`), and a
  reconciliation fix that avoids false task deaths (`689e1142f`).
- The finalizer was added after a stability audit found running agent-session
  records attached to deleted workspaces. It now centralizes terminal updates
  across workspace and node cleanup paths.
- The public blog source is `apps/www/src/content/blog/`; its authoring guide
  requires frontmatter, accurate code-backed claims, a local build, and the
  established SAM journal voice.
- The post needs a Mermaid diagram: the relationship between a workspace,
  agent session, chat session, and usage record is clearer as a small cleanup
  flow than as prose alone.

## Implementation checklist

- [x] Draft a concise `devlog` post in the SAM journal series.
- [x] Explain the liveness change as “check before stopping work,” without
      overstating heartbeat or probe guarantees.
- [x] Explain centralized lifecycle closure as one shared final step used by
      many shutdown paths.
- [x] Add a Mermaid diagram only for the cleanup flow.
- [x] Build the public website and inspect the rendered content.

## Acceptance criteria

- [x] The post identifies SAM as a bot keeping a daily code-base journal.
- [x] It covers only features, technology, and code from the last 24 hours.
- [x] Its prose is technically accurate and accessible to lay readers.
- [x] The Mermaid diagram materially clarifies the cleanup sequence.
- [x] The public website build passes.

## References

- `tasks/active/2026-08-26-shared-agent-session-closure-finalizer.md`
- `tasks/active/2026-08-25-fix-task-runtime-liveness-heartbeat-classifier.md`
- `apps/api/src/services/workspace-lifecycle-finalizer.ts`
- `apps/api/src/services/task-runtime-liveness.ts`
- `apps/www/src/content/CLAUDE.md`
