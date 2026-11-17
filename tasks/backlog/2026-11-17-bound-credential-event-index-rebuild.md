# Bound a future credential-event index rebuild

Parent idea: 01M7CX61WVX72T7CFQNRTX0DVM. Discovered during PR2836.

The recorded-event credential expression index includes every CI receipt with a null windowType. Its reader always compares windowType, so a partial non-null predicate could save one index write per future stored non-credential event. Real workerd measured a steady unmatched receipt at five writes with the existing index and four with the proposed predicate.

Do not rebuild it in a root ProjectData startup migration. Thirty-day retention and the recent admission rate imply a conservative 1.0–1.7M-row root table bound (an estimate, not a measured row count). JSON extraction while rebuilding could exhaust a Durable Object CPU/startup budget and block the root project's chats. PR2836 removes the proposed migration and ships only the zero-write CI skip.

Before implementing, measure the residual stored-event volume after the skip; retain only if savings justify the one-time cost. Use a real workerd fixture past1.7M rows, measure DROP and CREATE billed row counters, CPU/wall time and memory shape, then design a bounded background rollout with explicit throughput, resumability and rollback. Preserve credential supersession lookup plans and history. Do not use a production SQL write for research.
