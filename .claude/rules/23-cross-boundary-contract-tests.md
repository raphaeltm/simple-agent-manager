# Cross-Boundary Contract Tests

Keep this root rule compact. The full historical rule is preserved at `.agent-instructions/reference/rules/23-cross-boundary-contract-tests-full.md`.

- When one component calls another, test the caller and receiver contract together.
- Cover URL shape, auth format, payload schema, response parsing, timeout/cancellation behavior, and error classification.
- A mocked receiver must enforce the same contract the real receiver enforces.
- For adapter/runtime version changes, test the exact production launch path and fail closed on incompatible versions.
