# Trial Onboarding Configuration

SAM supports a zero-friction onboarding flow where visitors hit `/try` in the web app, paste a public GitHub repo URL, and get a live 20-minute workspace. Nothing is stored beyond the trial window unless the visitor claims it by signing in with GitHub.

This document covers the configuration knobs an operator turns when self-hosting trials.

> **Wave 0 status:** This page describes the *foundation* shipped in Wave 0 (types, DB migration, routes stubs, DO skeleton). The live create / events / claim / waitlist handlers land in Wave 1. Operators can safely deploy Wave 0 without setting any trial secrets — trials remain disabled until the kill-switch is flipped on.

## Required Worker Secrets

Set with `wrangler secret put <NAME>` (or the equivalent deploy-secret workflow in your fork):

| Secret | Required when | Purpose |
|---|---|---|
| `TRIAL_CLAIM_TOKEN_SECRET` | trials are enabled | 32+ bytes (base64 recommended). HMAC-SHA256 key used to sign the `sam_trial_claim` and `sam_trial_fingerprint` cookies. Rotating this invalidates all in-flight trials. |

All other trial-related values are public configuration and live in `wrangler.toml` / `[vars]`.

## Tunable Environment Variables

These are declared in `apps/api/wrangler.toml` at the top level (no `[env.*]` section — see `.claude/rules/07-env-and-urls.md`):

| Variable | Default | Meaning |
|---|---|---|
| `TRIAL_MONTHLY_CAP` | `1500` | Maximum trials started per calendar month (enforced by the `TrialCounter` Durable Object). Set to `0` to disable the cap. |
| `TRIAL_WORKSPACE_TTL_MS` | `1200000` (20 min) | Lifetime of a trial workspace before automatic teardown. |
| `TRIAL_DATA_RETENTION_HOURS` | `168` (7 days) | Hours to retain project data (chat sessions, knowledge, ideas) after the workspace expires, so a later claim can still pick up the trial. |
| `TRIAL_ANONYMOUS_USER_ID` | `system_anonymous_trials` | Sentinel `users.id` that owns trial projects until claim. Seeded by migration `0043_trial_foundation.sql`. |
| `TRIAL_AGENT_TYPE_STAGING` | `opencode` | Agent used on the staging environment (where no Anthropic credit is available). |
| `TRIAL_AGENT_TYPE_PRODUCTION` | `claude-code` | Agent used in production. |
| `TRIAL_DEFAULT_WORKSPACE_PROFILE` | `lightweight` | Devcontainer profile (see `packages/cloud-init`) used for trial workspaces. |
| `TRIALS_ENABLED_KV_KEY` | `trials:enabled` | KV key read by the kill-switch. |
| `TRIAL_KILL_SWITCH_CACHE_MS` | `30000` (30 s) | In-memory cache TTL for the kill-switch lookup. Lower = faster propagation, higher = fewer KV reads. |

## Kill Switch

Trials are **disabled by default**. To turn them on without a redeploy:

```bash
# Enable trials
wrangler kv:key put --binding=KV "trials:enabled" "true"

# Disable trials (any value other than "true" disables)
wrangler kv:key put --binding=KV "trials:enabled" "false"
```

The API caches the KV value for `TRIAL_KILL_SWITCH_CACHE_MS` (default 30 s), so toggling takes effect within that window. On KV read failure, the kill-switch fails **closed** (trials disabled) — the `TrialCounter` cap is still defended but no new trials start until KV recovers.

## Monthly Cap Reset

The monthly cap is enforced by the `TrialCounter` Durable Object. Each new trial increments a counter keyed by the current UTC month (`YYYY-MM`). The counter does not reset itself — the key simply changes on the first of the next month, leaving the old key untouched.

If you need to manually reset the counter (e.g. after a capacity increase), access the DO via `wrangler` or through the admin API (Wave 1+):

```bash
# From an ops shell with DO RPC access:
env.TRIAL_COUNTER.get(env.TRIAL_COUNTER.idFromName('global')).decrement('2026-04');
```

## Waitlist

When the monthly cap is hit, `POST /api/trial/create` returns `{ error: 'cap_exceeded', waitlistResetsAt }` and the frontend invites the visitor to queue for notification via `POST /api/trial/waitlist`. Entries are stored in the `trial_waitlist` D1 table with a unique `(email, reset_date)` index so the same visitor cannot queue twice for the same window.

A cron (Wave 1+) walks the table on the first of each month, sends notifications, and stamps `notified_at`.

## Data Retention

Trial projects are owned by the `TRIAL_ANONYMOUS_USER_ID` sentinel user until claim. Data is kept for `TRIAL_DATA_RETENTION_HOURS` past workspace expiry so a visitor who comes back within the retention window can still claim the trial with their GitHub account.

After the retention window, a sweep (Wave 1+) hard-deletes the project and all associated DO data.

## Security Notes

- Cookies (`sam_trial_fingerprint`, `sam_trial_claim`) are HttpOnly, Secure, SameSite=Lax, HMAC-SHA256 signed, constant-time compared on verify.
- The `TRIAL_CLAIM_TOKEN_SECRET` is the only secret required; no third-party credentials are needed for trial mode itself (the workspace uses platform-provided AI and infra).
- Kill-switch failure defaults to disabled. There is no code path where a KV outage silently bypasses the cap — the DO counter is the second line of defense.
