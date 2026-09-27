/**
 * Credential-token shapes every API redactor strips — the one definition they share.
 *
 * Each redactor used to carry its own copy, and the copies drifted: `services/secret-redaction.ts`
 * knew only Anthropic's `sk-ant-` keys, so OpenAI `sk-…`/`sk-proj-…` keys reached persisted
 * platform errors and model-visible diagnosis evidence verbatim while `lib/logger.ts` redacted
 * them; the logger in turn missed fine-grained GitHub PATs and cut SAM PATs at their first `-`.
 * A token family is defined here once so no redactor can know fewer shapes than its siblings.
 * The VM agent's Go redactor (`packages/vm-agent/internal/errorreport/snapshot.go`) is held to the
 * same `sk-`/GitHub shapes by the shared canary fixture `tests/fixtures/diagnostic-secret-canaries.json`.
 *
 * Only prefix-identified tokens belong here: `sk-`, `ghp_` or `sam_pat_` never occur in prose, so
 * one rule fits every redactor. `Bearer …`/`Basic …` values stay with each redactor on purpose —
 * those are English words, and a log line can afford to over-redact where a comment shown to a
 * user cannot.
 *
 * A lookbehind rather than `\b`: `_` is a word character, so `\b` misses `KEY_sk-…`, while refusing
 * an alphanumeric predecessor keeps words such as `task-runner-…` or `disk-usage-…` intact. Eight
 * body characters matches the VM agent and sits far below every real token (32+), which leaves short
 * hyphenated words such as `sk-learn` alone. Matching is case-insensitive, as in the VM agent.
 */
const CREDENTIAL_TOKEN_SHAPES: readonly string[] = [
  // Provider API keys: OpenAI `sk-…`, `sk-proj-…`, `sk-svcacct-…`; Anthropic `sk-ant-api03-…`,
  // `sk-ant-oat01-…`; OpenAI-compatible providers such as OpenRouter's `sk-or-v1-…`.
  String.raw`sk-[A-Za-z0-9_-]{8,}`,
  // GitHub tokens: classic PAT, OAuth, user-to-server, installation, refresh, fine-grained PAT.
  String.raw`(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}`,
  // SAM personal access and webhook trigger tokens; their bodies are base64url, so `-` counts.
  String.raw`sam_(?:pat|wh)_[A-Za-z0-9_-]{8,}`,
];

/** One alternation, so every string is scanned once however many families there are. */
const CREDENTIAL_TOKEN_PATTERN = new RegExp(
  `(?<![A-Za-z0-9])(?:${CREDENTIAL_TOKEN_SHAPES.join('|')})`,
  'gi'
);

/** Replace every credential token in `text` with `replacement`. */
export function redactCredentialTokens(text: string, replacement: string): string {
  return text.replace(CREDENTIAL_TOKEN_PATTERN, replacement);
}
