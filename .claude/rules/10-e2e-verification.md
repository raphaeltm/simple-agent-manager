# End-to-End Capability Verification

Keep this root rule compact. The full historical rule is preserved at `.agent-instructions/reference/rules/10-e2e-verification-full.md`.

- Multi-component features need at least one capability test that proves the complete user-visible path works.
- Do not accept isolated unit tests when the risk is a missing handoff between UI, API, worker, provider, or VM agent.
- Use realistic state and assert the final effect, not only intermediate calls.
- Pair this rule with `.claude/rules/23-cross-boundary-contract-tests.md` and `.claude/rules/35-vertical-slice-testing.md` when a feature crosses process or service boundaries.
