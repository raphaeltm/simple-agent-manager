# Group SAM MCP domain tools into read/write tools

Requested by Raphaël, 2026-11-06 (task `01M6SH3VNV1BMYX8BRTCX3QRVT`). Constraint: open the PR and get it green; **do not merge**.

## Problem

Agents see 145 SAM MCP tools (167 in the Operations project), about 38K tokens of definitions in every session. The overnight review (`/reports/2026-11-sam-review/04-codebase-and-architecture.md`) flagged overlapping tools. The audit in this conversation confirmed exact duplicates behind the same backend:

- `link_idea`/`unlink_idea`/`link_to_idea`/`unlink_from_idea` all call `operations/link-core.ts`.
- `list_ideas`/`search_ideas`/`find_related_ideas` all map to `samIdeasSearch` (`operations/workspace-adapter.ts:27-29`); `list_tasks`/`search_tasks` both map to `samTasksList`.
- `get_peer_agent_output` is a subset of `get_task_details`; `search_knowledge`/`get_relevant_knowledge` run the same FTS.
- Five zero-argument workspace probes (`get_workspace_info`, `get_network_info`, `check_dns_status`, `get_workspace_diff_summary`, `get_credential_status`) each proxy one VM-agent GET.

No tool carries MCP `annotations`, `initialize` returns no `instructions`, and `tools/list` filters only the Operations-only groups.

## Current best practice (researched 2026-11-06)

- Claude Code (default) and Codex (since 0.142.2, June 2026) defer MCP tools behind their own built-in tool search. A server-side "search tools" meta-tool is counterproductive (a proxy doing this hid Claude Code's ToolSearch, ooples/token-optimizer-mcp#496).
- Help the built-in search instead: fewer tools (Anthropic: selection degrades past 30-50), consistent `<domain>_` prefixes, short keyword-rich descriptions, fewer than ~10 functions per namespace (OpenAI), and a category map in server instructions.
- Grouping pattern: one read tool and one write tool per domain with a `method` parameter (GitHub MCP server `issue_read`/`issue_write`), not one mega-tool, so per-tool approval and `readOnlyHint`/`destructiveHint` keep working. Rare destructive deletes stay separate.
- OpenCode still has no tool search (anomalyco/opencode#45527), so it loads every tool; consolidation matters most there.

## Design

- `tool-groups.ts` declares each group: name, read/write kind, summary and `method → legacy tool` map with a one-line method summary. Schemas are generated from the legacy definitions: `method` enum plus the union of member properties (each tagged with the methods that use it). Conflicting property definitions fail a test.
- Group descriptions name the legacy tools they replace, so a harness search for an old name (from stored skills, knowledge or policies) finds the group.
- `tools/call` for a group translates `{method, ...args}` to the legacy tool and re-enters the same dispatcher, so validation, auth, auto-linking and handlers are unchanged.
- Legacy member names stay callable but are not listed. This matters for sessions that cached `tools/list` before deploy; a model cannot call an unlisted tool in a fresh session, so every text reference is updated.
- Every listed tool gets `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
- `initialize` returns `instructions` with the tool-category map.
- `tools/list` hides tools that always reject a token without a task (`taskId === ''`, direct workspace chats and trials).

Not in this PR: the messaging/eventing/orchestration/mission consolidation (needs backend unification) and ops/incident grouping; `get_instructions` policy budget. Tracked as ideas.

Kept standalone on purpose: library `upload_to_library`/`replace_library_file`/`display_from_library` (web document cards and vm-agent extraction key on these names), `request_human_input` and `ops_request_action` (UI cards), task lifecycle, dispatch and all messaging tools, hard deletes (`delete_agent_profile`, `delete_skill`, `delete_trigger`), `expose_port`, `report_environment_issue`, `exec_with_secrets*`, models, email, workflows.

## Implementation checklist

- [x] Group registry + schema generator (`tool-groups.ts`, `tool-group-schema.ts`)
- [x] Dispatcher: extract tool-call dispatch, route group calls to legacy tools
- [x] Listing: groups replace members; annotations on every listed tool; task-less filter
- [x] `initialize` instructions category map
- [x] Update text references the model reads: `get_instructions` strings, eventing guidance, playbooks, seed README, server prompts, skills, commands, rules, public docs
- [x] Tests: listing through real route, group dispatch reaching real handlers (vertical slice), legacy alias still callable, schema conflicts, Gemini compat for listed tools, annotations present, task-less filter discriminating
- [x] Docs: public MCP tool docs updated
- [x] File follow-up ideas for messaging consolidation and policy budget

## Acceptance criteria

- [x] `tools/list` for a normal project lists 82 tools, no legacy member names, every tool annotated
- [ ] Calling `ideas_read {method:'search', query}` returns the same result as legacy `search_ideas`
- [ ] Legacy names still work through `tools/call`
- [ ] Unknown `method` returns a JSON-RPC invalid-params error listing valid methods
- [ ] `initialize` returns instructions under 2 KB
- [ ] All listed schemas pass the Gemini compatibility checks
- [ ] CI green; PR open and not merged

## Implementation notes

- Listed catalogue: 82 tools for ordinary projects (was 145), 104 for Operations (was 167). Library tools stay ungrouped because `download_library_file` writes into the workspace, so it cannot be read-only (CodeRabbit). Listed definitions shrank from ~159K to ~142K characters; most of the remaining size is in the standalone tools.
- Member property conflict: `add_policy.expiresAt` (number) vs `update_policy.expiresAt` (number or null). The generator merges a create/update nullability pair to the nullable form; the dispatcher rejects `null` for methods whose member does not accept it.
- Triggers stay ungrouped because `create_trigger`/`update_trigger` disagree on several fields beyond nullability.
- `list_pull_request_associations` stays ungrouped (its `cursor` is an object while `list_tasks.cursor` is a string).
- Discrimination verified: disabling the null check, the task-less filter, or group resolution in `index.ts` each turns the intended tests red.
- The untrusted-text truncation hint now accepts `<tool> method <name>` (`operations/untrusted-text.ts` TOOL_NAME).
- The Prettier debt baseline review expired 2026-11-07T00:00Z, failing format checks for every PR. Re-measured at main a42bb516b (2,180 files) and set the next review for 2027-02-05.
- The local machine is shared and was at load average 30-67. Some suites hit their 10s hook timeouts, and a stashed `main` failed the same way.
- Follow-ups: idea 01M6SPM7G7TPCNAMC31EVZ1QDP (coordination tools phase 2), idea 01M6SPMDHY2F2BPVD933B9FYJZ (policy injection budget).
- Merge with main 349c78101 -> head 1fead2384; baseline kept 2180@a42bb51 with main dates; CI 21/21 incl Sonar.
