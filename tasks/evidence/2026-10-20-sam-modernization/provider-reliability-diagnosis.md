# Provider protocol and context diagnosis

Status: structural correction implemented and locally verified; live reliability remains a release blocker. This is not a successful live journey.

Four actual staging gateway request/response pairs were read using existing read-only access. Independent Astra High architecture and security reviewers inspected a local, pseudonymized copy. Raw requests, responses, private history, headers and canaries are not published.

## Observations

- The top-level SAM runtime is `@cf/google/gemma-4-26b-a4b-it`, through the Workers AI OpenAI-compatible chat endpoint. Requests set `max_tokens: 4096`; no reasoning-effort parameter is sent. The implementation agent and selected project worker are separately Astra High. A downstream profile does not select the top-level conversational model.
- All four requests contain the same 18 function definitions: the 17 explicit shared operations and private-history lookup. Dispatch includes required project/message fields and optional profile/task-mode fields.
- Two requests with `tool_choice: auto` receive provider responses containing prose, `finish_reason: stop`, and no tool calls. No adapter tool-call loss explains those responses.
- The captured bounded correction sends `tool_choice: required`. Its response contains a real `sam_chat_start` call. The next request preserves its name, arguments and call ID, followed by the matching tool result. The resulting answer uses returned identities.
- The installed Mastra `1.77.0` path uses `ModelRouterLanguageModel` with explicit `api: 'chat'` and its OpenAI-compatible adapter. Inspection confirms that it serializes function definitions and tool choice, and maps provider `message.tool_calls` into executable tool-call events. It does not turn prose claims into tool calls.
- The failed requests include historical unsupported dispatch answers, including fabricated session/task suffixes, and historical no-tool instructions. Their historical assistant prose is replayed without associated turn state or action receipts. The failed answers reuse the earlier dispatch template after resource substitutions.
- The schema bridge broadens some enum type declarations, but retains the finite enums and server-side Valibot validation. The identical schema successfully produces a dispatch in the captured sequence. Schema incompatibility is not established as this failure's cause.

The evidence establishes provider-generated no-tool prose and a context provenance gap. It supports context contamination as a cause to test, not a proven explanation of all model behavior.

## Correction and validation boundary

The implemented correction is confined to model input: group historical records by their canonical turn, include recorded terminal state and action references, and exclude assistant claims that fail grounding against that turn's receipts. Preserve the canonical transcript, search index and audit records. Preserve historical user constraints and the exact current user request. Retained historical assistant prose is escaped inside the server-generated status record. No new planner, classifier, model substitution, tool grant or generic forced mutation was added.

Native protocol tests must verify declarations and call/result mapping, historical projection, forks, byte bounds, interrupted/uncertain state and absence of replay. Live success still requires one complete dispatch → report → follow-up → confirmed-stop journey, including duplicate admission/confirmation and cleanup. A guard suppressing false claims is not sufficient.

Historical validation also makes long legacy messages relevant to grounding performance. URL trailing-punctuation removal now scans backwards once instead of using a potentially quadratic suffix regular expression. The 53 grounding unit cases pass, including long punctuation with and without a final non-punctuation character. This preserves source-matching behavior; it does not establish model reliability.

The dedicated staging account exceeded its enforced daily input-token budget during the last failed turn. Its cap remains unchanged, the failed receipts remain preserved, all owned resources are cleaned up, and SAM is OFF. No further VM allocation is justified until diagnosis and deterministic tests support another bounded run.

## Local verification

The native pre-fix regression failed because unsupported historical assistant content still reached the actual Mastra provider request. After correction: 57 native Mastra/workerd tests and 90 context/store/security/grounding unit tests pass. Independent security review separately passed 81 API tests and 38 staging-helper tests. API TypeScript, scoped lint, formatting and diff checks pass. The native request assertions cover all 18 declarations, call/result identity, exact current request and unchanged canonical false-claim evidence.

The full staging journey now has a 25-minute work bound plus a separate 3-minute cleanup bound, exact follow-up message/acknowledgement correlation, successful same-key replay invariance and a mandatory awake check before stop confirmation. These are prepared assertions, not live results. Actual follow-up answer semantics still require manual comparison with the initial report; acknowledgement/chronology is not independent mailbox-consumption proof.
