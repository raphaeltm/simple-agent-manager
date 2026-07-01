# Add Claude Code 1M Context Model Selectors

## Problem

The Claude Code model list exposes Claude Fable 5 but does not clearly expose the one-million-token context option, and the list is also missing the other currently supported Claude Code 1M selector variants.

## Research Findings

- SAM's static Claude Code dropdown lives in `packages/shared/src/model-catalog.ts`.
- `packages/shared/tests/model-catalog.test.ts` checks that every Claude Code dropdown model has a platform catalog entry, but Claude Code selector suffixes such as `[1m]` are not Anthropic API model IDs and should not be allowed as raw SAM AI proxy model IDs.
- Claude Code sets `ANTHROPIC_MODEL` from the selected model in `packages/vm-agent/internal/acp/session_host_startup.go`; the ACP wrapper also receives the selected model in `packages/vm-agent/internal/acp/session_host.go`.
- Official Claude Code docs say 1M context is supported for Fable 5, Sonnet 5, Opus 4.6 and later, and Sonnet 4.6. They document `[1m]` suffix selector values such as `claude-opus-4-8[1m]`.
- Official Claude model docs show Fable 5, Sonnet 5, and Opus 4.8 as native 1M context models. Sonnet 5 has no separate 200K variant, so it should be listed as a base model rather than `claude-sonnet-5[1m]`.
- Older Sonnet 4 / Sonnet 4.5 1M beta headers were retired on April 30, 2026 and should not be added.

## Implementation Checklist

- [x] Add Claude Code-visible 1M model choices for Fable 5, Sonnet 5, Opus 4.8, Opus 4.7, Opus 4.6, and Sonnet 4.6.
- [x] Keep `[1m]` selector variants scoped to the Claude Code dropdown rather than adding them to raw platform AI proxy allowed models.
- [x] Add platform catalog metadata for any new base Anthropic model IDs used by the dropdown.
- [x] Update model catalog tests to assert the full expected 1M selector list and the selector-to-base-model invariant.
- [x] Run focused shared tests and the repository quality checks required for this scoped change.
- [ ] Open a PR on the SAM output branch and deploy staging after CI is green.

## Acceptance Criteria

- Claude Code model selection includes the full current 1M context set:
  - Claude Fable 5
  - Claude Sonnet 5
  - Claude Opus 4.8 `[1m]`
  - Claude Opus 4.7 `[1m]`
  - Claude Opus 4.6 `[1m]`
  - Claude Sonnet 4.6 `[1m]`
- Raw SAM AI proxy allowed models do not include Claude Code-only `[1m]` selector strings.
- Tests cover the selector list and ensure each selector maps to a known base platform model.
- PR is created and CI is green before staging deployment.
