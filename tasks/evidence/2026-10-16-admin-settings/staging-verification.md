# Dynamic settings staging verification

Candidate: `b1e6cd202a4ed9737fe34d6aebadad2897207056`.

[Approved deployment and workflow smoke tests](https://github.com/raphaeltm/simple-agent-manager/actions/runs/38960469251) succeeded on 2026-10-16. `/health` returned healthy. The staging lease was explicitly handed over after the previous owner's actual VM cleanup; this test provisioned no VMs and changed no OAuth or operational-switch settings.

The retained [browser probe](staging-live.mjs) ran against the actual application and API with the existing managed active-superadmin smoke credential. Credentials, cookies and settings responses are not retained in this evidence. Browser startup initially failed because the relocated local workspace lacked a shared library; installing Playwright's standard dependencies resolved that before any login or setting write.

| Check                           | Actual result                              |
| ------------------------------- | ------------------------------------------ |
| Registry and secret projection  | 23 settings; every secret value null       |
| Real UI save and fresh API read | Connector read limit 120 → 121             |
| Stale revision                  | 409; no mutation                           |
| Invalid mixed batch             | 400; revision unchanged                    |
| Real UI reset                   | 120 and original `default` source restored |
| Unauthenticated GET             | Rejected (401/403 assertion passed)        |
| Layout                          | No page overflow at 375×667 and 1280×800   |
| Final revision                  | 2, following save and reset                |

Read-only Cloudflare D1 queries independently verified the upgrade and cleanup:

| Observation                    | Before migration | After migration, before test | After restore |
| ------------------------------ | ---------------- | ---------------------------- | ------------- |
| Settings revision/audit tables | 0                | 2                            | 2             |
| Existing settings rows         | 16               | 16                           | 16            |
| Existing credential rows       | 3                | 3                            | 3             |
| Revision                       | —                | 0                            | 2             |
| Audit rows                     | —                | 0                            | 2             |
| Test-setting override rows     | —                | —                            | 0             |

The audit schema contains only `id,name,action,actor_user_id,created_at,revision`. Existing-row byte preservation is additionally covered by the committed SQLite upgrade regression; row counts alone are not a byte-integrity claim.

The browser job finished successfully at 20:42:02 UTC, with guarded cleanup confirmed. Final D1 verification succeeded at 20:42:41 UTC. Both private-value-free heading captures were inspected. All browser contexts and jobs closed; the staging lease was explicitly released to the #2363 owner. No cleanup obligation remains for this test.

Main's subsequently released #2305 was normally integrated for production preservation. Its own staging and VM lifecycle evidence belongs to its owner. The feature staging result above remains pinned to its actual tested SHA; final integration checks and production evidence are recorded in PR #2304 rather than relabeling this historical run.

Post-run verification-script hardening: Sonar identified predictable shared-temporary artifact paths. The retained probe now creates a private atomic temporary directory for every journal and screenshot and loads Playwright through its public package entrypoint. Independent adversarial review passed, including a permissive-umask check (directory `0700`, journal `0600`). Syntax, formatting, package resolution and local artifact checks passed. No staging request was repeated; the historical live result above is unchanged.
