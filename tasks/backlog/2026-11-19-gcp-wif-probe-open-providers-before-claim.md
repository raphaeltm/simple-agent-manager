# Probe Google for issuer-only WIF trust before a first pool claim

## Problem

PR #2905 (task 01M7SB8FRZ08M5NEX9WGM74X61) made SAM refuse to sign identity tokens for a GCP workload identity pool that another owner's credential names or has claimed. Claims are sticky, so every pool SAM has ever recorded stays protected after a disconnect.

It cannot protect a pool SAM has **never** recorded whose Google-side trust is still issuer-only with a `pool/*` service-account binding:
- a pre-#2905 guided setup whose SAM credential was deleted before #2905 deployed;
- a platform pool an admin created in Google before saving the platform credential.

Any approved user who knows the project number, pool, provider ID and service-account email can save a credential naming it, claim it first, and impersonate the service account (independent adversarial review of #2905, M1).

Related: claim squatting with no proof of control (cloudflare-specialist M3, security L3): any approved user can claim unbounded pools from metadata alone.

## Proposed fix

Before the first claim of a pool (no claim, no holder), mint a probe identity token with a synthetic foreign `user_id`/`project_id` for the named provider and call Google STS. If STS accepts it, the provider trusts SAM's issuer alone: refuse the save/exchange and tell the owner to re-run guided setup. Treat any STS failure as "not open".

Decide with Raphaël whether the probe should also run on exchanges of already-claimed pools (closes legacy issuer-only providers fleet-wide, but would refuse production's one legacy guided connection until its owner re-runs setup).

Also consider: a per-owner cap on claims, and recording a claim when a deployment credential is saved.

## Acceptance criteria

- [ ] A first claim of a pool whose named provider accepts a foreign `user_id` is refused, with a message telling the owner to re-run setup
- [ ] A user-scoped (guided) provider passes the probe
- [ ] STS errors other than acceptance do not block the claim
- [ ] Decision recorded on probing already-claimed pools
- [ ] Tests: attack (open provider refused), owner control (scoped provider claimed), STS error control
