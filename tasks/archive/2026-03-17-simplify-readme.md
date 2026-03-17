# Simplify README

## Problem

The current README lists features but doesn't communicate the core developer experience: describe work in chat, SAM provisions infrastructure and runs an AI agent autonomously, chat history persists at the project level. The architecture section is a static diagram without narrative explanation.

## Research Findings

- **Core workflow**: Create project (link GitHub repo) -> Open project chat -> Describe task -> SAM autonomously provisions VM, creates workspace, runs Claude Code -> Results stream back to chat -> Chat history persists beyond workspace lifecycle
- **Key architectural innovations**: Alarm-driven TaskRunner DO orchestrates multi-step provisioning; warm node pooling for fast iteration; hybrid D1 + per-project DO storage for real-time chat without contention
- **Current README**: 141 lines, has a good cost comparison table and deploy section, but the features list is flat and the architecture diagram lacks narrative
- **Files to change**: Only `README.md`

## Implementation Checklist

- [ ] Rewrite hero section to emphasize the developer workflow (chat-driven autonomous coding)
- [ ] Simplify features to 3-4 core items with brief explanations
- [ ] Add a "What You Do" or workflow section showing the developer experience step-by-step
- [ ] Rewrite architecture section with narrative explanation of how components connect
- [ ] Keep the Quick Deploy section (it's already good)
- [ ] Keep Development commands section
- [ ] Remove or trim sections that add length without core value (Related Projects can stay minimal)

## Acceptance Criteria

- [ ] README clearly communicates: "describe work in chat, SAM runs it autonomously"
- [ ] Architecture section explains the flow narratively, not just as a static diagram
- [ ] Total length is shorter than current (aim for ~100 lines or less of content)
- [ ] Quick Deploy instructions preserved
- [ ] No broken links
