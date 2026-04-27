# Never Ship Broken Features (ABSOLUTE RULE)

## This Rule Overrides All Others

If a feature does not work end-to-end on staging as an end user would experience it, **you do NOT merge**. Period. No exceptions. No rationalizations. No workarounds. No "it's expected because [reason]."

This rule exists because an agent shipped a broken feature to production after rationalizing staging errors as "expected." The feature errored on every use. The user was explicit: **"Never. Ever. Do that again."**

## The Hard Gate

When asked to test on staging, you MUST:

1. **Complete a full end-to-end test as an end user would.** Not a page load. Not a navigation check. The actual feature, exercised from start to finish, producing the expected outcome.
2. **If the feature errors, fails, or does not produce the expected outcome: STOP.** Do not merge. Do not rationalize. Do not create workarounds. Alert the user immediately.
3. **If infrastructure or tooling prevents the feature from working (e.g., wrong Wrangler version, missing binding, unsupported API): STOP.** This means the feature is not ready. Do not merge a feature that cannot function in the deployed environment.

## Anti-Rationalization Rules

The following rationalizations are BANNED. If you catch yourself thinking any of these, you are about to ship broken code:

| Rationalization | Why It's Wrong |
|----------------|----------------|
| "The error is expected because the binding/config isn't set up yet" | If the config isn't set up, the feature doesn't work. Don't ship it. |
| "End-to-end testing requires a credential that isn't configured" | Then the feature is untestable, which means it is unshippable. Notify the human and stop. |
| "The feature flag correctly prevents users from hitting the broken path" | Feature flags that hide broken code are not features. They are broken code with a UI mask. |
| "The API returns the right response even though the underlying service errors" | If the service errors, the feature is broken. A 200 response wrapping a broken backend is a lie. |
| "This will work once [X] is configured/upgraded/deployed separately" | If it doesn't work NOW, it doesn't ship NOW. |
| "The UI correctly shows the option, it just errors when you use it" | A button that errors when clicked is worse than no button at all. |
| "I verified that the config endpoint works, which is the main change" | The main change is the FEATURE, not the config endpoint. Verify the feature. |
| "Staging verification isn't possible for this specific integration" | Then the feature isn't ready to merge. Alert the user. |
| "The code is correct, it's just a deployment/infrastructure issue" | Users don't experience code. They experience deployed software. If it's broken when deployed, it's broken. |

## What "End-to-End" Means

For any feature, the end-to-end test must:

1. **Start from the UI entry point** — the button, form, page, or action the user would use
2. **Execute the complete flow** — fill forms, click buttons, submit, wait for results
3. **Verify the outcome** — the expected result appears, data is persisted, the action completes successfully
4. **Encounter ZERO errors** — no error toasts, no console errors related to the feature, no failed API calls, no error states

If ANY step produces an error, the feature is broken. Full stop.

## When the Feature Cannot Work on Staging

If the feature genuinely cannot function on staging due to infrastructure limitations, missing credentials, or missing configuration:

1. **Do NOT merge.** The feature is not ready.
2. **Add a comment on the PR** explaining exactly what is missing and what needs to happen.
3. **Notify the human via `request_human_input`** (SAM MCP tool) with:
   - What is broken and why
   - What credential, secret, or infrastructure change is needed
   - What the options are (configure the missing piece, defer the feature, find an alternative approach)
4. **Label the PR `needs-human-review`.**
5. **Wait for the user's decision.** Do not self-resolve by masking the broken functionality.

## Relationship to Other Rules

- **Rule 13 (Staging Verification)** says staging verification is mandatory. This rule says the verification must PASS — not just be performed.
- **Rule 21 (Timeout Merge Guard)** says don't merge under time pressure. This rule says don't merge under ANY pressure if the feature is broken.
- **Rule 22 (Infrastructure Merge Gate)** says infrastructure items block merge. This rule says ANY broken behavior blocks merge.

## Incident Reference

On 2026-04-25, an agent shipped the Artifacts-Backed Projects feature to production despite the feature erroring on staging. The agent rationalized the error ("Artifacts binding requires Wrangler v4+, which isn't available yet") and merged anyway. Every user who tried to create an Artifacts-backed project got an error. The feature was completely broken in production.

The correct action was to STOP, alert the user that Wrangler v4+ was required, and wait for a decision. Instead, the agent masked the error by removing the binding check from the config endpoint and merged broken code.

See `docs/notes/2026-04-25-artifacts-broken-merge-postmortem.md`.

On 2026-04-26, an agent shipped SAM Agent Phase A (PR #823) to production without ever testing the actual chat feature. The agent rationalized: "End-to-end chat requires a configured Anthropic platform credential" and substituted page-load checks for feature verification. The chat was completely broken (TransformStream deadlock, zero bytes streaming). The correct action was to notify the human about the missing credential and wait — not merge untested code.
