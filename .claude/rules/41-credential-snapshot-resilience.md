# Credential Snapshot/Resolution Must Tolerate a Single Bad Row

## When This Applies

This rule applies to any code that builds an in-memory snapshot of stored
credentials, or resolves a credential, by **decrypting and parsing multiple
rows** from D1 (user credentials, platform defaults, configurations). The
composable-credentials snapshot (`apps/api/src/services/composable-credentials/snapshot.ts`)
is the canonical example.

## Why This Rule Exists

PR #1315 (composable-credentials) shipped a `parseSecret('cloud-provider', token)`
that called `JSON.parse(token)`. But hetzner cloud-provider tokens are stored as
a **raw** string, not JSON. The `JSON.parse` threw a `SyntaxError`.
`buildPlatformDefaults` runs on **every** snapshot build, and neither
`getDecryptedAgentKey` nor `createProviderForUser` wraps the resolver in a
try/catch — so the throw rejected the entire snapshot, escaped to
`app.onError`, and `/agent-key` returned 500. The VM agent saw "control plane
returned status 500", `SelectAgent` failed, and **every agent for every user**
reported "agent status is error". Rolling back production fixed it, proving the
merge broke agent chat. A single malformed platform row took down credential
resolution for the entire fleet.

## Hard Requirements

1. **Per-row isolation.** When iterating credential/config/platform rows to
   build a snapshot, wrap each row's decrypt + parse in its own try/catch. On
   failure, **skip the row and log a structured error** (`console.error` with
   the row id, kind, and error message). One bad row must never reject the whole
   snapshot.

2. **Parsers must not throw on unexpected encodings.** A secret-parsing function
   must tolerate every encoding that exists in production. cloud-provider and
   openai-compatible secrets exist as BOTH raw token strings (hetzner, legacy
   backfill) AND JSON objects (`{provider, token}`, `{apiKey, baseUrl}`). Use a
   non-throwing `tryParseJsonObject` helper and fall back to treating the value
   as a raw token — never let `JSON.parse` escape.

3. **The agent-key / provider-resolution path returns 500 only on genuine
   server faults.** A malformed stored credential is data, not a server fault.
   It must degrade to "skip that credential" (and fall through to the next tier
   or return null), never a 500.

## Required Tests

Any change to credential snapshot/resolution building MUST include behavioral
tests that:

- Seed a RAW (non-JSON) cloud-provider platform default and assert the snapshot
  builds without throwing AND an unrelated agent still resolves.
- Seed a JSON cloud-provider default and assert it still parses correctly.
- Seed an undecryptable credential row (bad iv/ciphertext) and assert it is
  skipped, not fatal, and good rows remain.
- Assert `getDecryptedAgentKey` (or the equivalent resolution entry point)
  returns the key (no 500) while a malformed default is present.

## Quick Compliance Check

Before merging changes to credential snapshot/resolution code:
- [ ] Every row decrypt+parse is wrapped per-row; failures skip+log, not throw
- [ ] Secret parsers tolerate both raw-string and JSON encodings (no bare JSON.parse)
- [ ] A malformed stored credential cannot produce a 500 on the agent-key path
- [ ] Behavioral tests cover raw, JSON, and undecryptable rows
