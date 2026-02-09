# Constitution Validation

ALL changes MUST be validated against the project constitution (`.specify/memory/constitution.md`) before completion.

1. Read and understand all constitution principles before making changes
2. Validate EVERY change against Principle XI (No Hardcoded Values):
   - NO hardcoded URLs — derive from environment variables (e.g., `BASE_DOMAIN`)
   - NO hardcoded timeouts — use configurable env vars with defaults
   - NO hardcoded limits — all limits must be configurable
   - NO hardcoded identifiers — issuers, audiences, key IDs must be dynamic
3. Fix any violations before marking work as complete
4. Use sequential thinking to verify compliance

### Quick Compliance Check

Before committing any business logic changes, verify:
- [ ] All URLs derived from `BASE_DOMAIN` or similar env vars
- [ ] All timeouts have `DEFAULT_*` constants and env var overrides
- [ ] All limits are configurable via environment
- [ ] No magic strings that should be configuration
