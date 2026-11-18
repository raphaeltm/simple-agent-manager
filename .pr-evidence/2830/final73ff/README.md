# Final73ff staging verification harness

Prepared for normal primary deployment44246119415 at73ff0956fb26362a11680d44f23f5348328c470a. NOT EXECUTED at this evidence commit; no claim of live validation.

Copy verify.ts to repository .tmp/l9-live/final.ts so relative imports resolve. It uses installed Playwright and the repository's document plus clipped-overflow helper. Browser libraries must be available through the process library path. After verifying terminal deployment success/exact head/own lease, execute via managed exec_with_secrets with SAM_PLAYWRIGHT_PRIMARY_USER, SAM_PLAYWRIGHT_SECONDARY_USER and CF_TOKEN. Never print tokens or persist browser state. It signs each fixture out in finally and emits a sanitized report. Screenshots/reports stay local until separately reviewed and published.

Primary regression uses real APIs and UI, waits for real project overview200 and loaded Home/Settings, and stops on the first failed stage. Secondary hybrid intercepts ONLY browser GET list-accounts to omit GitHub; server proofs/refusals/readback/IP/step-up mail request are real. Existing approved fixtures remain linked; no new principals/provider unlink/VMs. External OAuth and delivered mail remain subject to the limited human exception quoted in PR2830.

This is an evidence-only branch; NEVER MERGE it into main. It contains earlier feature history solely to host the existing screenshot evidence.
