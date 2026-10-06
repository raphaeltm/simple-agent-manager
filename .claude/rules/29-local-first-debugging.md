# Local-First Prototyping and Log-Driven Debugging

Keep this root rule compact. The full procedure and log matrix are preserved at `.agent-instructions/reference/rules/29-local-first-debugging-full.md`.

- Prove what you can locally before using staging.
- When staging or production fails, query state first, then read logs, then change code.
- Preserve the exact user-visible symptom while checking backend records, logs, UI state, cache, polling, and optimistic updates as separate hypotheses.
- Do not guess-and-redeploy; every fix should follow observed evidence.
