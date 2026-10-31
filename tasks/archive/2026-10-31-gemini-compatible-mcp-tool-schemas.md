# Gemini-compatible sam-mcp tool schemas, prompt failure detail, and OpenCode key redaction

## Problem

On 2026-10-31 an OpenCode chat (task `01M68GSNK7E7WY586KJZV9FDVM`, profile "OC", model
`opencode-go/gemini-4-argon`) failed with `agent_prompt_failed` after 12.9s. The user suspected the
new OpenCode API key format. The real cause, found only in the node debug package
(`vm-agent.log`, `Agent stderr` lines), was:

```
Upstream request failed: [400] Unable to submit request because `sam-mcp_create_agent_profile`
functionDeclaration `parameters.runtime` schema specified other fields alongside any_of.
When using any_of, it must be the only field set.
```

The key authenticated fine. Google Vertex rejected one of SAM's own MCP tool schemas.

Two contributing gaps:

1. The VM agent drops the unclassified prompt error entirely: the `ACP Prompt failed` lifecycle
   report carries only `agent_prompt_failed`, so platform logs could not explain the failure.
2. OpenCode keys changed from `sk-…` to `oc_sk_…`. No SAM redactor knows that shape, so a new key
   that appears in stderr, a diagnostic, or a callback payload would not be masked.

## Research Findings

- **Transport.** models.dev routes `opencode-go` through `@ai-sdk/openai-compatible`
  (`https://opencode.ai/inference/go/openai/v1`), so OpenCode's JSON Schema reaches Vertex nearly
  verbatim after OpenCode's own Gemini sanitizer.
- **OpenCode's Gemini sanitizer** (`packages/opencode/src/provider/transform.ts`, `sanitizeGemini`,
  v1.18.32) turns a JSON Schema type array `type: ['string','null']` into
  `anyOf: [{type:'string'}], nullable: true` and keeps every sibling (`enum`, `description`,
  `properties`). It also stringifies enum values (`null` becomes `"null"`, `1` becomes `"1"`) and
  passes `oneOf`, `allOf` and `const` through untouched. Vertex requires `anyOf` to be the only
  field of its node.
- **Why `runtime` was first.** OpenCode appears to send tools alphabetically. `create_agent_profile`
  is the first tool with an offending node, and `runtime` (type array plus `enum` with `null`) is
  the node that failed.
- **Scan of `MCP_TOOLS`** (149 tools) found 42 offending nodes:
  - type arrays in `tool-definitions-shared-fields.ts` (`resourceRequirements` through
    `resourceRequirementsMcpProperty`, `resourceRequirementsJson`, `runtime`), the skill tools
    (`agentType`), the trigger tools (`description`, `agentProfileId`, `skillId`,
    `vmSizeOverride` with a null enum, `resourceRequirements*`, webhook filter `value`), the
    workspace tools (`dispatch_task.devcontainerConfigName`), the policy tools
    (`update_policy.expiresAt`), the project-awareness tools
    (`get_archived_tool_payloads.startTime`/`endTime`), the workflow tools (`wait.subject`) and the
    project-schedule tools (`agentProfileId`/`skillId`);
  - `anyOf` with a `description` sibling in the event-subscription filter (`source`, `eventType`,
    `subjectType`, `subjectId`, `severity`);
  - a non-string enum (`filter.version: enum [1]`, which Gemini receives as `"1"`);
  - `oneOf` in `create_project_schedule.action` (with `const` discriminators) and
    `start_workflow_run.plan.steps.items` (`oneOf` of `required` lists alongside
    type/properties).
- **No handler validates arguments against the advertised schema.** Tool handlers validate their
  own inputs, so changing a schema's shape does not change accepted values. Null still clears
  fields on update, provided the advertised schema still offers null.
- **Out of scope:** `routes/connector-mcp.ts` (the ChatGPT/Claude connector) builds its schemas
  from Zod operations and is not served to workspace agents.
- **Redaction sites for `oc_sk_`:**
  - `apps/api/src/lib/credential-token-redaction.ts` (the shared API shapes);
  - `packages/vm-agent/internal/acp/session_host_crash.go` (`diagnosticRedactionPatterns`, which
    also covers stderr lines);
  - `packages/vm-agent/internal/server/server.go` (`taskCallbackDiagnosticRedactionPatterns`);
  - `packages/vm-agent/internal/errorreport/snapshot.go` (`sensitiveValuePatterns`);
  - `apps/web/src/lib/analytics.ts` (`SECRET_PREFIX_RE`).
  The cross-language canary fixture is `tests/fixtures/diagnostic-secret-canaries.json`.
- **Prompt failure path:** `finishPromptAttemptWithError` in
  `packages/vm-agent/internal/acp/session_host_prompt.go` reports `error: agent_prompt_failed`.
  `reportPromptRetry` and the activity `StatusError` already carry redacted error text, the latter
  truncated to 2048. `ClassifyPromptFailure` asks callers not to include the raw string once it
  has been classified.

## Implementation Checklist

- [x] Add a nullable-schema helper. Rewrite every type array as `anyOf` that is the only field of
      its node (description moves into the non-null branch); `null` stays representable through a
      `{type:'null'}` branch.
- [x] Event subscription filter: put `anyOf` alone on its node and move descriptions into the
      branches; express `version` without a non-string enum.
- [x] `create_project_schedule.action`: `oneOf` → `anyOf`, and `const` → single-value string enum.
- [x] `start_workflow_run` steps: drop the `oneOf` of `required` lists, document the two step
      shapes in descriptions, and confirm the handler enforces them.
- [x] Add a regression test that walks every `MCP_TOOLS` input schema and enforces the Gemini
      rules: no type arrays, `anyOf` is the only field of its node, no
      `oneOf`/`allOf`/`const`/`not`/`if`/`$ref`, string-only enums. Include a fixture case for the
      exact pre-fix `runtime` shape, and port OpenCode's sanitizer so the test also checks the
      post-sanitizer output.
- [x] Update any existing schema-shape assertions in tests.
- [x] VM agent: on an unclassified prompt failure, add a redacted, UTF-8-safe, bounded `detail`
      field to the `ACP Prompt failed` lifecycle report and the slog line; classified failures keep
      the code only.
- [x] Add `oc_sk_` to every redaction site listed above, plus a canary fixture entry, and extend
      the Go and TS canary tests.
- [x] Update docs that describe redacted token shapes or MCP schema conventions, if any.

## Acceptance Criteria

- [x] No `MCP_TOOLS` schema contains a Gemini-incompatible node, enforced by a test that fails on
      the pre-fix `create_agent_profile.runtime` shape.
- [x] Nullable update fields still accept `null` (the handler behavior tests still pass).
- [x] An unclassified prompt error produces an `ACP Prompt failed` report with a redacted `detail`;
      a token inside the error does not survive; a classified error carries no raw detail.
- [x] `oc_sk_` canaries are redacted by the API redactor and every VM agent redactor.

## Notes

- `apps/web/src/lib/analytics.ts` needed no change: its `LONG_OPAQUE_SEGMENT_RE` already scrubs
  `oc_sk_…` path segments (24+ chars with letters and digits).
- Discrimination checks run: reverting the schema sources reddens 12 tool cases plus 9 shape
  assertions; truncating before redacting reddens `TestPromptFailureDetailRedactsBeforeTruncating`;
  deleting the Go `oc_sk_` pattern reddens the unclassified-detail and truncation tests (acp), the
  task-callback redaction test (server) and `TestErrorDeliveryRegistersAndUploadsOnlyRedactedAutomaticEvidence`
  (errorreport); a naive byte slice reddens the UTF-8 test; deleting the API shape reddens the two
  canary-driven redaction suites.
- Review round 1 (security-auditor HIGH, go-specialist HIGH): the acp and server span redactors
  were near-duplicate lists, weaker than errorreport's (no AWS/Google/OAuth/Slack/npm/Stripe/JWT/PEM)
  and `\b`-anchored, which misses `KEY_sk-…` because `_` is a word character. Consolidated both into
  `packages/vm-agent/internal/diagredact` with a `(^|[^A-Za-z0-9])` prefix group (RE2 has no
  lookbehind), the full shared shape set, and tests over the shared canary fixture plus
  `_`-joined variants. Correction to the audit: `Reporter.Report` already runs errorreport's strong
  `sanitizeString` over the context before the outbox insert, so only the journal slog line used the
  weak list. Discrimination: removing the added shapes reddens the acp canary test and three
  diagredact tests; a `\b` prefix reddens the underscore test for all five shapes.
- `main` is branch-protected (GH013), so the task file is committed on the feature branch.

- Staging deployment was skipped by explicit user instruction (2026-10-31).
- The OpenCode v2 upgrade is a separate task: `01M69A9YWZ9J4KWZ2YB4E4GTHE`.
