# Cloud-Init Package (packages/cloud-init)

## Purpose

Generates cloud-init YAML templates for VM provisioning. Produces the user-data script that configures Docker, installs the VM agent, sets up TLS certificates, and bootstraps workspaces on new nodes.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Public API — `generateCloudInit()` export |
| `src/template.ts` | YAML template with variable placeholders and multi-line content embedding |
| `src/generate.ts` | Variable resolution — maps input config to template variables |

## Commands

```bash
pnpm --filter @simple-agent-manager/cloud-init build      # Bundle with tsup (ESM + DTS)
pnpm --filter @simple-agent-manager/cloud-init test       # Run Vitest
pnpm --filter @simple-agent-manager/cloud-init typecheck  # Type check only
```

## Conventions

- Output is cloud-init YAML (not JSON) — indentation is load-bearing
- Multi-line content (PEM certs, SSH keys) uses YAML block scalars (`|`)
- Template variables are resolved in `generate.ts`, not interpolated with string templates
- Tests MUST parse output with a YAML parser and assert on the parsed structure (rule 02)

## Gotchas

- **YAML indentation is critical** — a single extra/missing space breaks cloud-init parsing on the VM. The TLS YAML indentation bug (`docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`) caused production outages.
- **Tests must use realistic multi-line data** — 1-3 line PEM stubs hide indentation bugs that only manifest with real 20+ line certificates.
- **Always assert round-trip integrity** — `expect(parsedYaml.field).toBe(originalInput)` for embedded content.
- Built with `tsup` (not plain `tsc`) — outputs ESM with `.d.ts` declarations.
- Changes here require infrastructure verification on staging (provision a real VM) per rule 02.
