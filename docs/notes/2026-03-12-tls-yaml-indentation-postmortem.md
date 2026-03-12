# TLS Certificate YAML Indentation Post-Mortem

**Date**: 2026-03-12

## What Broke

All workspace provisioning stopped working after PR #320 (TLS for Worker-to-VM agent communication) merged. VM agents crashed on startup with invalid TLS certificates, causing:
- No heartbeats sent to the control plane
- No workspace provisioning (health checks never succeed)
- Nodes stuck in permanent `stale` health status

## Root Cause

PR #320 added Origin CA TLS certificates to the cloud-init template using YAML literal block scalars (`|`). The `generateCloudInit()` function at `packages/cloud-init/src/generate.ts:54-55` did a plain string replacement:

```typescript
'{{ origin_ca_cert }}': variables.originCaCert ?? '',
```

In the template (`packages/cloud-init/src/template.ts:114-116`):
```yaml
  - path: /etc/sam/tls/origin-ca.pem
    content: |
      {{ origin_ca_cert }}
```

When the placeholder was replaced with a multi-line PEM certificate (20+ lines), only the first line inherited the template's 6-space indentation. All subsequent PEM lines were at column 0. YAML `|` block scalar rules set the indentation level from the first content line — lines with less indentation terminate the block. The cert file on the VM ended up containing only `-----BEGIN CERTIFICATE-----\n`, and the remaining PEM lines became garbage YAML that cloud-init may have silently ignored or errored on.

The VM agent's `ListenAndServeTLS()` (Go) received a truncated PEM → immediate crash → systemd restart loop → agent never started.

## Timeline

- **2026-03-12 ~08:27 UTC**: PR #320 merged to main, deploy workflow ran
- **2026-03-12 ~08:30 UTC**: Production deployment completed
- **2026-03-12 ~11:00 UTC**: User reported both symptoms (no heartbeats, no provisioning)
- **2026-03-12 ~11:30 UTC**: Root cause identified as YAML indentation bug

## Why It Was Not Caught

### 1. Tests used unrealistic data (primary failure)

The existing test at `generate.test.ts:126` used a 3-line `fakeCert`:
```typescript
const fakeCert = '-----BEGIN CERTIFICATE-----\nMIIBxTCCAW...\n-----END CERTIFICATE-----';
```

This is not how real PEM certs look. A real Origin CA cert has 20+ lines of base64. The 3-line test happened to survive the broken indentation because all 3 lines were short enough that YAML parsers handled the edge case leniently.

### 2. Tests only checked string containment

Tests asserted `expect(config).toContain('BEGIN CERTIFICATE')` — this passes even when the cert is truncated to just the first line. No test parsed the YAML output or verified the full PEM content survived intact.

### 3. Staging verification was superficial

The agent was asked to test in staging but did not provision a VM to verify the full TLS flow. Staging verification checked that the UI rendered and API responded, but did not exercise workspace creation — the exact flow broken by this change.

### 4. No infrastructure-specific verification gate

The quality gates mention "workspace creation and lifecycle operations work" in the staging verification section, but this was listed as one bullet among many. For changes to cloud-init, VM agent config, DNS records, or TLS — the infrastructure that VMs depend on to boot — there was no **mandatory** requirement to provision a real VM and verify it starts.

## Class of Bug

**Template output corruption due to unrealistic test data.** When a template engine produces structured output (YAML, JSON, XML), tests must verify the output is valid in the target format, not just check that strings appear somewhere in the output. This is analogous to testing SQL generation by checking `toContain('SELECT')` instead of actually executing the query.

More broadly: **string containment tests on structured output create false confidence.** The test passes, the CI is green, but the output is malformed.

## Process Fix

1. **`.claude/rules/02-quality-gates.md`**: Added "Infrastructure Change Verification" gate requiring actual VM provisioning for changes touching cloud-init, VM agent, DNS, or TLS. Added "Template Output Verification" rule requiring YAML/JSON parse tests for template changes.

2. **`.codex/prompts/do.md`** and **`.agents/skills/do/SKILL.md`**: Updated staging verification phase to make infrastructure verification explicit and blocking — must provision a VM and verify heartbeat arrives for infrastructure changes.

3. **`.github/pull_request_template.md`**: Added infrastructure verification checkbox.
