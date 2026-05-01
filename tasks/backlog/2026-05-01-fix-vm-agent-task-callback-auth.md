# Fix VM Agent Task Callback Auth

## Problem

During the Claude OAuth passthrough staging probe on 2026-05-01, the VM agent completed the prompt and produced the expected assistant response, but the task remained `in_progress` because the completion callback returned 401.

Observed node log:

```text
Task callback: unexpected status statusCode=401 taskId=01KQJA8DTXJ8G71H8YPMX07VE9
```

## Context

- Project: `01KJVGMWX26SGQ5DX94GMTJRQN`
- Task: `01KQJA8DTXJ8G71H8YPMX07VE9`
- Workspace: `01KQJACB3F8KNFXCWDH6FJ7D30`
- Agent session: `01KQJADKKQXEKZ3372CBHYRA3K`
- Callback path observed in Cloudflare logs:
  `/api/projects/01KJVGMWX26SGQ5DX94GMTJRQN/tasks/01KQJA8DTXJ8G71H8YPMX07VE9/status/callback`

## Acceptance Criteria

- [ ] VM agent task completion callback authenticates successfully in staging.
- [ ] Conversation-mode tasks transition out of `in_progress` after agent completion.
- [ ] Regression test covers the callback auth mechanism used by VM agent.
- [ ] Staging verification demonstrates a conversation-mode task completes without manual close.
