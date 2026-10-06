# Agent policy and memory review

## Problem

Recent SAM-managed work exposed a concrete agent-dispatch failure: several Codex tasks were dispatched with descriptions beginning with `/do`. Codex interpreted the first prompt as an unsupported slash command, rejected the turn, and did not process SAM-injected bootstrap instructions such as `get_instructions`.

The same review found one idea-state update: the task-backed/forkable chat sessions idea has an open implementation PR, but it is not merged, so future agents should treat the idea as still open.

## Research findings

- Session `b865a567-9cff-4257-91a6-0082e52b72e6` records the `/do` leading-slash failure.
- Affected tasks included `01KXAWYBYF1XC0PJR5VNTHFYRZ`, `01KXAXA54RFEJW1X2VVR6362XG`, and `01KXARPHXSDGSWQGRR58E42RWP`.
- Existing guidance requires dispatch descriptions to instruct agents to use `/do`, but it did not explicitly distinguish prose skill instructions from leading slash-command syntax.
- Local reviewer consensus: two independent reviewers returned PASS on the narrow docs/policy fix and the open-PR idea update.
- PR #1572 (`https://github.com/raphaeltm/simple-agent-manager/pull/1572`) is open/unmerged as of 2026-07-14 for the task-backed/forkable chat work.

## Checklist

- [x] Get local subagent critique and confirm consensus.
- [x] Update SAM idea `01KXAQH5HA168AMSRC5WH1ZTG2` with PR #1572 open/unmerged evidence.
- [x] Update dispatch guidance to forbid leading slash-command syntax while preserving prose `/do` instructions.
- [x] Validate documentation-only changes.

## Acceptance criteria

- Agent guidance says dispatched SAM task descriptions must not begin with `/do` or any slash command.
- Agent guidance preserves the required prose instruction: `Execute this task using the /do skill.`
- The task-backed/forkable chat idea remains open with explicit PR #1572 evidence.
