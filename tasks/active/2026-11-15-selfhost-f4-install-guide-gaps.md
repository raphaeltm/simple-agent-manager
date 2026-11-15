# Self-host F4: install-guide gaps from box round R14

SAM task 01M7EB09K6FZTNA55WRYD2WQH4, parent 01M7AF82KG9C78WAABTG3V1MN1. Base branch
`sam/selfhost-pass-2` (b2b3a4056). Draft PR, not merged by the agent. No staging deploy: only
self-host files change, nothing ships to Cloudflare.

## Problem

Box round R14 rebuilt the test box by following `deploy/selfhost/README.md` literally (idea
01M7DHBFERXG63MBNBMXB5068H, note of November 15, "README GAPS" and "NEW DEFECTS" item 2; evidence
in "BOX ROUND R14" parts 1 to 3 on idea 01M77HYN8N41MQ17TQZ622PPPV). It found six documentation
gaps and one misleading refusal message.

## Research findings

- Only one README exists: `deploy/selfhost/README.md`. There is no `scripts/selfhost/README.md`.
- R1: the README's "Create the box" block grants the bucket and `roles/dns.admin` right after
  `gcloud iam service-accounts create`; both fail with "does not exist" for a few seconds. The
  bootstrap already retries its IAM bindings (`change_retry` in `deploy/selfhost/gcp-bootstrap.sh`),
  so only the README needs the wait and retry.
- R2: `git clone` gives `main`, which has no `deploy/selfhost` yet.
- R3: neither the README block nor the bootstrap's node setup enables `cloudbilling.googleapis.com`.
  The price table (`packages/providers/src/gcp-pricing.ts`) reads Google's public Compute Engine
  list prices with the node service account's token; it needs the API enabled in that project and
  no IAM role (`GCP_REQUIRED_APIS` in `packages/shared/src/constants/gcp-required-apis.ts`; public
  docs `google-cloud.md` say the same). Enabling an API needs `serviceusage.services.enable`, which
  the documented operator (project owner) has, as for the other APIs the bootstrap enables.
- R4: no pointer from "Create the box" to the first account (SMTP or the mail collector, and
  `BOOTSTRAP_OWNER_EMAIL` in `.state/secrets.env`, which needs `mkdir -m 700` before `--init`).
- R5: "refuses such a key the same way" is unclear. On a new box the refusal shows only "denied
  (403)" because the bootstrap stops before granting the box account.
- R6: no word on running docker without the docker group (sudo), and `gcloud compute ssh` is fine.
- Message: `candidateFix` in `scripts/selfhost/key-choice.ts` names the dead-key cause and the
  `--new-key-version` command only for FAILED_PRECONDITION. The `denied` branch must also name a
  key whose versions are destroyed or scheduled for destruction and print the same command.
  `--new-key-version` is a no-op on a key whose primary version is ENABLED
  (`ensure_primary_version` returns early), so printing it for every GCP denial is safe: on a live
  key it only adds the grant. `sealingFloorRefusal` stays as it is.
- Object store: `.env.example` defaults to `COMPOSE_PROFILES=tunnel,gce` and a `gs://` bucket;
  `CELLD_BUCKET` has no default (`deploy.ts` requires it). No documented default selects
  `local-store` on a cloud VM. The compose file already says celld does not qualify the bundled
  MinIO fork for production; the README does not say it.

## Checklist

- [x] R1: wait for the service account and retry both grants in the README block
- [x] R2: say to check out `sam/selfhost-pass-2` after the clone (easy to delete later)
- [x] R3: enable `cloudbilling.googleapis.com` in the README block and in the bootstrap's node setup; test
- [x] R4: pointer from "Create the box" to the first account (`mkdir -m 700`, `BOOTSTRAP_OWNER_EMAIL`, sender)
- [x] R5: rewrite "refuses the same way"; docker group (sudo) and `gcloud compute ssh` notes
- [x] Message: GCP `denied` names the dead-key cause and prints the `--new-key-version` command; tests
- [x] Bootstrap test: `--new-key-version` on a live key changes no version (backs the message's claim)
- [x] Object store: say in the README which store an install uses; report that no default selects local-store

## Acceptance criteria

- Following "Create the box" literally works without retyping a failed command.
- `deploy --init` on a GCP box denied by Cloud KMS names the dead-key cause and the exact
  `--new-key-version` command (unit test through the real `deploy.ts --init` entry).
- The bootstrap's node setup enables the Cloud Billing API (bootstrap test).
- `pnpm` self-host tests pass; CI run on the branch is green (or only the known flake).
