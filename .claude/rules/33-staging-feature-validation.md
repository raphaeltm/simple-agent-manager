# Staging Feature Validation Methodology

Keep this root rule compact. The full methodology is preserved at `.agent-instructions/reference/rules/33-staging-feature-validation-full.md`.

- Staging validation must exercise the actual changed behavior, not only page load or endpoint reachability.
- Create realistic setup data, perform the user workflow, and verify the final persisted or visible result.
- For streams, browser-only behavior, OAuth, DNS, and VM flows, use the live staging path.
- Record concise evidence in the task/PR.
