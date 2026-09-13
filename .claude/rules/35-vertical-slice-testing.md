# Vertical Slice Testing

Keep this root rule compact. The full historical rule is preserved at `.agent-instructions/reference/rules/35-vertical-slice-testing-full.md`.

- Cross-boundary features need at least one test that starts at the real entry point and follows the data through every relevant layer.
- Use realistic multi-variant state so the test would fail if routing, authorization, filtering, or persistence drops the value.
- Avoid empty mocks that only prove a helper can be called.
- Pair with `.claude/rules/10-e2e-verification.md` and `.claude/rules/23-cross-boundary-contract-tests.md`.
