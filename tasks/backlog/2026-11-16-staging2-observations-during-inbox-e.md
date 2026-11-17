# Staging2 observations while verifying Inbox slice E (2026-11-16)

## Problem

Found on staging2 (sammy2.party) while verifying PR #2781 (task 01M7JC1MTRFT8PWRQ8BNFP8D6W). None is
caused by slice E; each needs its own look.

1. **Automation runs ignore an Instant profile.** A cron trigger whose agent profile has
   `runtime: 'cf-container'` (project 01M7JEQ3Z6V03E1CYBJE0M0G61, trigger 01M7JG2XRQH9ZJHAV71K4B74X6)
   placed its runs on VMs: run task 01M7JG31SS1D0KK2NK7VQXRADA failed with "Workspace placement was
   refused 3 times in a row". A direct task submit with the same profile started an Instant container.
2. **Instant standalone clone failure.** An Instant start with an `openai-codex` Instant profile on an
   Artifacts project failed at launch: `Node Agent request failed: 500 standalone git clone failed:
exit status 128` (task 01M7JG4D76SGFCP2WBDFVA3F0P), while a Claude Code Instant start in the same
   project minutes earlier cloned fine.
3. **`incident_triggers` sweep failing repeatedly.** The staging2 admin receives a `cron_failure`
   notification "Operational sweep failed: incident_triggers" roughly hourly (12:20Z, 13:21Z, 14:25Z,
   15:31Z).
4. **SAM-proxy agents fail with 402.** AI Gateway unified billing balance is exhausted on staging2
   (reported by slice F2 on feature.inbox, code 2052); every SAM-proxy Claude Code first prompt fails.

## Acceptance Criteria

- [ ] Trigger runs honour the profile's runtime (Instant profile → Instant container), with a test
- [ ] The Instant clone failure is reproduced and its cause found (or ruled a staging data issue)
- [ ] The `incident_triggers` sweep failure is diagnosed from Workers logs and fixed
- [ ] Staging2 SAM-proxy billing is topped up or its users get a BYOK key (needs a human)
