# Personal-key warning on an automation repeats the same line

## Problem

The "Personal credential attribution" banner on an automation page lists one line per personal
credential check, but every line reads "This runs on <owner>'s personal key." With two checks (for
example, the agent's key and the cloud key) the banner shows the same sentence twice and does not
say which credential each line is about.

`credential-attribution-health.ts` builds the warning without the check's `label`, and
`TriggerCredentialWarning.tsx` renders only `check.warning`, although each check carries a
`label` and a `fixHref`.

## Context

Seen on staging on 2026-10-23 on an email automation in Test Project 1, during the agent email test
for draft PR #2413. Unrelated to agent email.

## Acceptance Criteria

- [ ] Each line names the credential it is about (use `check.label`), so two personal checks read
      differently
- [ ] Each line links to its `fixHref`
- [ ] A component test renders two personal checks with the same owner and asserts both lines are
      distinct and name their credential
- [ ] Playwright screenshots at 375 and 1280 px show the banner with two checks
