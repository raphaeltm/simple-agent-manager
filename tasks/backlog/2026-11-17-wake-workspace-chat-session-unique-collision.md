# Wake fails three times with UNIQUE constraint on workspaces.chat_session_id

## Problem

Production session `9d7a8b42-66f9-42a7-aef5-3a7a57b12f28` (task stuck-failed then woken) spent its
whole wake budget on 2026-11-16 between 14:48Z and 16:30Z: five wake claims each returned to sleep
with `Wake attempt failed; saved conversation retained: D1_ERROR: UNIQUE constraint failed:
workspaces.chat_session_id`. The snapshot ended at `recovery_attempts = 3`, "SAM spent the wake retry
budget for this sleep snapshot".

## Context

Found during task `01M7MZJJWKJYV88BSMQEGJPBXB` (provider-limit holds, idea
`01M7MMRHF3VZRKREC2XBMSC7HF`), verifying whether usage-limit rejections spend the wake budget. They
did not here: this collision is unrelated. The task had earlier been failed by the stuck-queued
watchdog at 14:20Z (idea `01M7JC0VW2GHT3JEM1P0WE064P`) while a workspace bound to the chat already
existed (`01M7JBNTEY1AZE8R714FX9JKQK`, created 14:20:17Z).

## Acceptance Criteria

- [ ] Root cause of the collision identified (which writer binds the chat to a second workspace while
      the first still holds `chat_session_id`).
- [ ] A wake for a chat whose previous workspace still holds the binding either releases it or
      reports a retry-class refusal; it never spends the wake budget on the collision.
- [ ] Regression test through the real wake path on a real SQL engine.
