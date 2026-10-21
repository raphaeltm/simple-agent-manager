# Journey03: preserved link-assertion failure

Journey `347ee25a-a9ea-4d63-ab4d-fad0a5f2f65c` failed after receiving a project answer and verifying the persisted launch contract and live ACP evidence for `gpt-6-astra`, effort `high`. Follow-up and confirmed-stop acceptance were not reached; this is not a full journey pass.

The test selected an absolute `href` attribute. The approved UI uses React Router internal links with a relative attribute; the DOM link destination resolves to the exact expected absolute project-session URL. Independent review reproduced this discrepancy using the actual receipt link parser. The test now checks a visible, accessible “Open chat” link with the exact internal path and exact resolved destination. The real receipt-rendering Playwright audit uses the same assertion on four viewports. A separate `source-link` failure phase distinguishes UI assertion failures from runtime evidence failures without retaining raw prompts or errors.

The immutable failed ledger SHA-256 is `1efd92e9f95aca96e5e473eef8bb73c7284a6099637331563bf22aa35d7b9c1c`. Runner03 was not replayed. All six owned cleanup receipts confirmed. The original per-user budget was restored at 20:53:41 UTC; independent readback at 20:58:26 confirmed no custom budget, original null limits/monthly cap and alert 80, effective 500,000 input/200,000 output, SAM OFF, and the unchanged baseline resource inventory. The restoration-only backstop was cancelled after proof.

Usage delta: 23,942 input and 1,104 output tokens, calculated Gemma cost US$0.0027254. Retaining the full conservative VM allowance US$0.1024 and ancillary allowance US$0.10 gives US$0.2051254 for this run and US$0.5114848 cumulative additional accounting. No outstanding reservation or override remains. These are conservative accounting values, not an atomic provider billing cap.

Application code is unchanged from Opus-approved staged commit `07a1e3b1aca17fc1ce7775615ff5daa37f5a1e92`. A fresh bounded journey, final checks/reviews and production release remain required.

Validation: four real-rendering Playwright viewport cases passed (375, 390, 768 and 1280 px), web TypeScript and scoped lint passed. Independent Astra High review passed nine offline Chromium cases: valid relative link and hidden duplicate before visible link accepted; wrong session/origin/query/hash, hidden-only link, foreign base resolution and foreign expected origin rejected. No live requests or inference were used for this diagnosis/review.
