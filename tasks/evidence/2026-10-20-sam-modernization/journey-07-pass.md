# Journey07 live staging verification

Candidate: `cd6aeed8fb84c10e596022961657ffa99bcf19ce`.

- CI39516530278, E2E39516530222 and staging39518314402 succeeded. Storage activation was skipped, not passed.
- Worker deployment19bb8e05-bd85-4750-920b-60172e7162eb, version207d5ade-f7bd-44d5-9474-227dbd9a99c4 served the exact candidate at100%. Frontend Deploy Web UI step and smoke succeeded. Existing Pages metadata permission remains unavailable; no grant added.
- One Playwright full journey passed in10.3minutes, exit0 at2026-10-21 00:29:25UTC. Exactly one dispatch and one follow-up, same allocated workspace/node, applied Astra High worker contract, initial report/source link, private-memory isolation, successful follow-up replay without extra effects, explicit scoped stop approval, fresh exact VM stop event before cleanup, repeated same completed confirmation, and terminal/stopped control-plane state all passed.
- Runtime stop acknowledgment proves the scoped workspace runtime stopped; it does not claim synchronous container or VM deletion. Separate owned-resource cleanup passed afterward.
- All six cleanup steps confirmed. Independent readback00:29:55 verified SAM alreadyOFF, original four-node/seven-workspace inventory unchanged, and exact original noncustom budget:500000input/200000output, null custom limits/monthly cap, alert80. This run made no budget writes.
- Usage137921input/1738output, Gemma model costUSD0.0143135 plus conservative VMUSD0.1024 and ancillaryUSD0.10 =USD0.2167135. Aggregate additional task accountingUSD1.3634289; no unresolved reservation. Existing worker subscription unchanged; not a billing hard-cap guarantee.
- Top-level runtime: `@cf/google/gemma-4-26b-a4b-it`; implementation/project worker: `gpt-6-astra`, high. No model substitution.
- Private ledger SHA256: `549a307a1a7c9e5b7a25ce226ebb4a6e6674b6537c5ce88fea3bdeda6bb523fe`. Raw transcript/private test data are not published. Earlier failed ledgers remain immutable and were not replayed or reclassified.

This proves the launch journey, not later roadmap parity or production release. Latest-main checks, final reviews, CodeRabbit and production remain release gates.
