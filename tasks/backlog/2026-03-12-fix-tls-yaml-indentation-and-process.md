# Fix TLS Certificate YAML Indentation + Process Gap

## Problem

PR #320 introduced TLS for Worker-to-VM agent communication. The cloud-init template uses YAML `|` literal block scalars to write Origin CA cert/key files to VMs. However, `generateCloudInit()` does plain string replacement of multi-line PEM content without indenting subsequent lines to match the YAML block scalar indentation level (6 spaces).

**Result**: YAML block scalar terminates after the first PEM line → VMs get truncated cert files → VM agent crashes on `ListenAndServeTLS()` → systemd restart loop → no heartbeats, no workspace provisioning.

**Impact**: All workspace provisioning broken since PR #320 merged (2026-03-12).

## Root Cause

`packages/cloud-init/src/generate.ts` line 54-55 does:
```typescript
'{{ origin_ca_cert }}': variables.originCaCert ?? '',
```

The template at `packages/cloud-init/src/template.ts` line 114-116:
```yaml
  - path: /etc/sam/tls/origin-ca.pem
    content: |
      {{ origin_ca_cert }}
```

When `{{ origin_ca_cert }}` is replaced with a multi-line PEM, only the first line gets the 6-space indent from the template. Subsequent lines at column 0 terminate the YAML block scalar.

## Why It Shipped

1. **Test used unrealistic data**: `fakeCert` was a 3-line string; tests only checked `toContain('BEGIN CERTIFICATE')` — never parsed the YAML or verified the full cert survived
2. **Staging verification was superficial**: The agent was asked to test in staging but did not verify that a VM actually provisioned and sent heartbeats after the TLS change
3. **No infrastructure-specific verification gate**: The quality gates mention "workspace creation and lifecycle operations work" but don't REQUIRE it for infrastructure changes

## Research Findings

- **Key files**: `packages/cloud-init/src/generate.ts`, `packages/cloud-init/src/template.ts`, `packages/cloud-init/tests/generate.test.ts`
- **Process files**: `.claude/rules/02-quality-gates.md`, `.codex/prompts/do.md`, `.agents/skills/do/SKILL.md`
- **Post-mortem format**: See `docs/notes/2026-03-09-cors-origin-fallthrough-postmortem.md` for template
- **PR template**: `.github/pull_request_template.md`
- **The cloud-init package has no YAML parsing dependency** — will need to add `yaml` or verify structurally

## Implementation Checklist

### Code Fix
- [ ] Fix `generate.ts`: indent multi-line PEM content to match YAML block scalar (6 spaces)
- [ ] Add helper function `indentForYamlBlock()` that pads each line of a multi-line string
- [ ] Verify the fix handles edge cases: empty string, single-line, trailing newlines

### Tests
- [ ] Replace `fakeCert`/`fakeKey` with realistic multi-line PEM strings (20+ lines of base64)
- [ ] Add test: parse generated YAML, extract cert content, verify full PEM survives intact
- [ ] Add test: generated cert file content matches original PEM byte-for-byte (trimmed)
- [ ] Add test: generated key file content matches original key byte-for-byte (trimmed)
- [ ] Add regression test: if indent helper is removed/broken, YAML parse fails
- [ ] Keep 32KB size limit test with realistic cert sizes
- [ ] Run `pnpm --filter @simple-agent-manager/cloud-init test`

### Post-Mortem
- [ ] Write `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`

### Process Fix
- [ ] Add "Infrastructure Change Verification" gate to `.claude/rules/02-quality-gates.md`
- [ ] Add "Template Output Verification" rule: cloud-init changes MUST include YAML parse test
- [ ] Update `/do` skill (`.codex/prompts/do.md`) staging phase: make infrastructure verification explicit and blocking
- [ ] Update `.agents/skills/do/SKILL.md` to match
- [ ] Update PR template: add infrastructure verification checkbox

### Quality
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (all packages)

## Acceptance Criteria

1. Generated cloud-init YAML with real multi-line PEM certs parses correctly
2. Full PEM content survives template generation intact
3. Tests would FAIL if the indentation fix were reverted
4. Post-mortem documents the bug class and timeline
5. Process rules prevent this class of bug from recurring
6. `/do` skill requires infrastructure verification evidence before merge
