# GitHub trigger queue UI evidence

Playwright: `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/github-trigger-queue-audit.spec.ts --project='iPhone SE (375x667)' --project='Desktop (1280x800)'`

Eight cases passed at 375×667 and 1280×800: normal, long names and 35 events, empty history, and failed history requests. Checks cover horizontal/clipped overflow, clear queued/routing/routed/drop labels, and the routed Chat target.

Variants considered: separate metric cards, inline counters above the existing run list, or a new queue tab. Selected inline counters: it preserves the existing hierarchy and keeps all outcomes in one list on phones.

Implementation agent reviewed mobile normal and desktop many/long screenshots. No clipping or overflow found. Rubric: hierarchy 4/5, clarity 4/5, mobile usability 5/5, accessibility 4/5, consistency 5/5. Existing shared components and styles retained. The actual Opus 5.5 Chat review is a separate required gate; its task/result will be linked in the PR.

After actual Opus review, all four medium and eight low findings were addressed: ambiguous handoff retains `delivery_uncertain` and an amber Unconfirmed outcome, excluded from definite dropped counts; History and detail use the stable routed session; waiting/rejected targets do not link to stale chats; counters have a visible label, distinguish current waiting from retained history, omit zeros and hide delivered totals when affinity is off; queue states, hints, deletion copy and accessible names are explicit. Backend queue reviewer confirmed no delivery fence weakened.

Updated evidence: normal now includes uncertain and unavailable targets; empty uses true zero counts and no past trigger activity; error waits for the actual alert. History routed link is asserted and captured at both sizes. Queue settings default/opt-in/invalid states are captured at both sizes. Browser cases: existing eight pass plus two controls cases (the first controls attempt advanced past the edit details step; corrected navigation, then both pass). Total 16 screenshots. Implementation agent inspected all captures for overflow, clipping, readability and responsive behavior; no visual issues after corrections. Final controls use the existing `INPUT_CLASS` for visible input boundaries. Actual Opus follow-up approval is still required.

Follow-up review added manual cleanup/deletion fencing for durable startup reservations. Normal fixtures now include a managed queued startup row; browser assertions prove no delete or Clear stuck runs action appears for it. All10 browser cases passed again. Definite expired/rejected entries have no stale Chat link; backend cleanup repeats its predicate at the final write and reports actual changes.

Final combined follow-up evidence: all14 browser cases pass (10 queue +4 controls). Queue captures now total18, including saved queue settings in Advanced at both sizes. Queue controls share Review → Advanced with overlap controls, use shared CheckRow/Field semantics, and show a 24-hour default with fractional hours supported. Non-GitHub recent-run hints retain ordinary chat wording; visible Event numbers and the actual history retention window replace internal retention jargon. Routing, delivered and unconfirmed fixtures each include immutable audit target IDs. Screenshots were refreshed together after the full combined run; mobile enabled controls and desktop saved settings were visually inspected. Both actual Opus reviews requested changes; final approval remains pending on the integrated candidate.

Final source candidate (B10297c0a1 integrated): combined16/16 Playwright cases pass. All18queue +26filter/context PNGs refreshed after the complete run. Affinity summaries explicitly describe continuing this automation’s active subject chat or starting a new one; browser assertions verify both editor and detail wording. Implementation agent inspected the updated mobile enabled controls, desktop review summary and mobile empty fields. Final typecheck passes after correcting the summary state reference;79focused web and2preview-service tests pass. Actual combined Opus approval is still pending.

## Final combined delta after Opus report01M5WPE4XVPAFCJ2D3PPS1M1H0

All earlier HIGH/MEDIUM findings were independently verified fixed by actual Opus at6cbc654. Its new2MEDIUM/9LOW findings have these dispositions:

- M1: push excludes affinity in Review/detail, and create/update normalize it tofalse; regression preserves true for supported issue/PR subjects. Push detail+Review are captured at both sizes.
- M2: overview says See all conditions, with no misleading numeric/more claim.
- L1: cleanup copy is plain, GitHub-specific preservation copy appears only on GitHub; GitHub/webhook/schedule dialogs captured and asserted at both sizes.
- L2: existing-chat hint appears only when affinity is enabled and the event has an issue/PR subject.
- L3: overview action describes subject-chat reuse or a new chat, excludingpush; dedicated affinity overview captures/assertion.
- L4/L5: PR source branches say from, role/state values read as words, review prefixes say Body starts with.
- L6: enum errors are attached to the field with aria-invalid/describedby; error screenshots at both sizes.
- L7: technical minimum hint removed. Repeating fractional hours for unusual existing integer-second TTLs is explicitly retained to preserve exact values. A unit-aware input is tracked/linked as SAM Idea01M5WPPXJJ508RTDEW8NHZSC1F; default24hours and saved human duration remain clear. This LOW polish item changes no functional TTL acceptance.
- L8: run metadata is one wrapping line, EventN is GitHub-only and absent for unknown/zero sequence, and Chat accessible names use run for other sources.
- L9: shared Disclosure starts closed when empty and retains user-open state when the final value is cleared; event switches do not open it for stale hidden values.

Final integrated source9abcf9519:24/24 browser cases PASS,80focusedwebtestsPASS, webtypecheck/lintPASS. All60PNGs (30queue +30controls) refreshed together after the full run; new push/mobile, compact history/mobile, webhook cleanup/desktop and enum-error/mobile captures visually inspected. Actual Opus delta verification remains merge-blocking; no approval is claimed here.

## Actual final Opus delta and error-state follow-up

Required-profile Opus task01M5WQWV8QGFQV7EM3AWQHG239 reviewed21e6bd0ab730561a1be30b8c855f0c92bf529f63: PASS, zero critical/high/medium findings, two nonblocking LOW findings (Library01M5WSB6453SGRP25B0YW3WKA1, coordination channel43). It independently ran80focusedwebtests,24desktop/mobilebrowsercases and17queue tests. Both prior MEDIUM findings were fixed; L7 exact TTL rationale accepted.

The two LOW residues are addressed in the follow-up: enum validation has its own blocking key so it cannot overwrite action errors; local submitted validation clears when values change; failed Continue opens enclosing disclosures before scrolling to the field error. Existing shared enum checks already normalize letter case; new browser assertions preserve that behavior. Actor clauses say “by” to distinguish them from source branches. Browser regressions failed before fixes and pass after fixes on desktop/mobile, covering correction, collapsed invalid sections, simultaneous action+enum errors and valid mixed-case values. The same actual Opus session will verify the pushed follow-up SHA before merge. No approval of unseen changes is claimed.

Follow-up verification: webtypecheck/lint PASS,111focusedtests PASS,24/24desktop/mobilebrowsercases PASS. All60captures refreshed together; mobile field-error view visually inspected. Local delta completeness review PASS.

Review correction: extra inline case normalization was redundant because githubFilterChoiceErrors already normalizes case. Removed it to keep the patch minimal; no case-normalization bug is claimed.

Final scope correction: clearing old submitted errors is limited to GitHub’s When step. What/Review retain their existing handlers, so correcting a bad queue TTL after Save keeps Advanced open. A new desktop/mobile browser regression verifies that correction path; all4affected browser cases and68editor/flow tests pass after narrowing. No additional visual redesign or backend change.
