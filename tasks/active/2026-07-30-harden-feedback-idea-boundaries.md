# Harden feedback Idea instruction boundaries

## Problem

Report Issue and platform feedback triage create draft Ideas in the maintainer feedback project from externally sourced data. Draft status and project permissions gate execution, but a maintainer can later promote/run an Idea and the agent can retrieve its full content through MCP `get_idea`. The current report Idea text labels the content as untrusted but leaves the user description as ordinary Markdown, so malicious text can read like task instructions.

## Research Findings

- `apps/api/src/services/report-issue.ts` builds draft Idea descriptions in `buildIdeaContent()`. It redacts secrets/PII and uses a warning note, but the user-supplied report body is appended as free-form Markdown.
- `apps/api/src/services/platform-feedback-triage.ts` creates and updates draft Ideas from observability-derived error groups. It already normalizes/redacts raw messages and only stores bounded metadata/evidence refs, but the resulting description is still ordinary prose rather than a consistent untrusted-evidence block.
- `apps/api/src/routes/mcp/idea-tools.ts` returns `description` as `content` in `get_idea` without transformation. Preserving a clear boundary in stored content is therefore sufficient and avoids brittle runtime rewriting.
- `apps/web/src/pages/project-chat/types.ts` supplies the default execute-Idea prompt. It tells agents to read the Idea and execute using `/do`, but does not generically remind agents that Idea content may include untrusted quoted evidence.
- `apps/web/src/pages/project-chat/useProjectChatState.ts` only pre-fills and submits the execute-Idea prompt; no report content is transformed there.
- Existing tests cover redaction and consent-gated refs in `apps/api/tests/unit/report-issue.test.ts`, and redacted/bounded platform feedback in `apps/api/tests/unit/services/platform-feedback-triage.test.ts`.

## Implementation Checklist

- [x] Add a tight shared formatter/helper for maintainer-authored instructions plus fenced untrusted evidence.
- [x] Use the formatter in Report Issue Idea creation so malicious report text is stored only inside an inert evidence fence.
- [x] Use the formatter in platform feedback triage Idea creation/update so observability-derived metadata/evidence remains clearly non-instructional.
- [x] Add a generic execute-Idea prompt reminder that Ideas can contain untrusted evidence and agents must not follow commands inside quoted/fenced evidence.
- [x] Add/update report Issue tests for malicious text, shell commands, fake secrets/emails, and Markdown/code fences.
- [x] Add/update platform feedback triage tests for malicious observability text and fenced bounded evidence.
- [x] Verify MCP `get_idea` preserves the stored boundary clearly.
- [ ] Run required validation: targeted tests, lint, typecheck, broader tests/build as practical.
- [ ] Run specialist review: security-auditor, task-completion-validator, test-engineer, constitution-validator; include Cloudflare review if API persistence changes warrant it.
- [ ] Open PR with explicit security-boundary wording, deploy to staging, verify, merge only when checks/staging pass, and monitor production deploy.

## Acceptance Criteria

- Report-created Ideas still insert as draft Ideas in the configured feedback project.
- Consented refs remain consent-gated and unauthorized refs remain silently dropped.
- Redacted secrets/emails do not appear in title/content where existing redaction expects removal.
- External report text, including malicious prompt-injection text and Markdown/code fences, is nested inside an explicit untrusted evidence block rather than appearing as free-form task instructions.
- Platform feedback triage Ideas remain draft and bounded/redacted, with observability-derived content clearly marked as untrusted evidence.
- `get_idea` returns Idea content with the instruction/evidence boundary intact.
- Normal user-created Ideas are not rewritten or degraded.
