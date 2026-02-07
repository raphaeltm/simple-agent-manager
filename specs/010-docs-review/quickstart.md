# Quickstart: Documentation Review and Update

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Date**: 2026-02-07

## Quick Reference

### Priority Matrix

| Priority | Action | Files |
|----------|--------|-------|
| **P1** | Fix critical inaccuracies | `getting-started.md`, `002-stateless-architecture.md`, broken `access-control.md` links |
| **P2** | Update outdated content | `ROADMAP.md`, `CONTRIBUTING.md`, `001-monorepo-structure.md`, research disclaimers |
| **P3** | Improve completeness | `packages/ui/README.md`, placeholder standardization |
| **P4** | Polish and consistency | Formatting, archival organization |

### Review Checklist (per document)

1. Does the content match the current codebase?
2. Are all file/path references valid?
3. Are all internal links working?
4. Is the tone appropriate for the target audience?
5. Are placeholder values consistent?
6. Is the document still relevant?

### Common Fix Patterns

**Adding historical disclaimer to research docs:**
```markdown
> **HISTORICAL DOCUMENT**: This represents early research from [DATE].
> Current implementation differs significantly.
> See [docs/architecture/](../../docs/architecture/) for actual architecture.
```

**Marking ADR as superseded:**
```markdown
**Status**: Superseded by [ADR-XXX](link) | **Date**: YYYY-MM-DD
```

**Standardized placeholders:**
- Domains: `example.com`
- GitHub org: `your-org`
- GitHub user: `your-username`

### Files That Need NO Changes

These 11 files passed review with grade A:
- `.specify/memory/constitution.md`
- `.github/pull_request_template.md`
- `docs/architecture/secrets-taxonomy.md`
- `docs/guides/agent-preflight-behavior.md`
- `docs/guides/ui-agent-guidelines.md`
- `docs/guides/ui-standards.md`
- `docs/guides/mobile-ux-guidelines.md`
- `docs/guides/local-development.md`
- `docs/guides/local-system-smoke-tests.md`
- `docs/adr/001-github-app-over-oauth.md`
- `docs/adr/003-ui-system-stack.md`

### Key Metrics

- **Total documents**: ~35 in scope
- **No changes needed**: 11 (31%)
- **Minor updates**: 9 (26%)
- **Major rewrites**: 7 (20%)
- **Research disclaimers**: 6 (17%)
- **Out of scope**: ~90 (specs, templates, commands)
