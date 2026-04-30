# Subtle LOTR References in Agent Voice

**Created**: 2026-04-30
**Priority**: Low
**Classification**: `product-polish`

## Idea

Give SAM agents a light-touch way to include Lord of the Rings-inspired references without making the product feel like a joke, derailing technical work, or annoying users.

## Rationale

SAM already has a quiet LOTR connection through Samwise. The product can lean into that personality in the places where a little warmth helps, while keeping technical answers precise and professional. The reference should feel like an occasional wink, not a bit the agent keeps repeating.

## Product Approach

Use a configurable "flavor layer" in agent profiles rather than baking references into every response. The profile can define:

- **Frequency**: off, rare, occasional
- **Allowed moments**: completion notes, empty states, low-stakes progress updates, celebratory milestones
- **Blocked moments**: errors, security issues, billing, legal/medical/high-stakes advice, frustrated-user interactions, production incidents
- **Style**: allusive language only, avoiding direct quotes and lore dumps

Examples of acceptable patterns:

- "I’ll keep this short and carry the context forward."
- "The path is clear: first fix the failing test, then update the docs."
- "This is one for later, but worth keeping in the map."

Examples to avoid:

- Direct quotes from the books or films
- Calling users or agents by character names
- Forced metaphors in bug reports, incidents, billing, or security conversations
- Repeating the same reference across a thread

## Implementation Sketch

1. Add an optional `voiceFlavor` section to agent profiles with `theme`, `frequency`, and `blockedContexts`.
2. Add a small system-prompt instruction that says LOTR references are opt-in, rare, allusive, and must never reduce clarity.
3. Let users disable the flavor globally or per project.
4. Add a lightweight evaluation checklist for agent responses: no direct quotes, no forced jokes, no references in blocked contexts, technical content still complete.

## Acceptance Criteria

- [ ] Agent profile settings can express subtle LOTR-inspired flavor without requiring code changes per agent.
- [ ] Users can turn the flavor off.
- [ ] References are blocked for errors, incidents, billing, security, and other sensitive contexts.
- [ ] Prompt guidance explicitly prefers clarity over theme.
- [ ] Test/evaluation examples cover acceptable and unacceptable responses.
