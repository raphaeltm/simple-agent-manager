# Self-host: install-wide teardown (`pnpm selfhost:teardown`)

Task T1 (SAM task 01M7826RB334YQBSTNRJWZP20Y), idea 01M77HYN8N41MQ17TQZ622PPPV. Base `sam/selfhost-pass-2`,
draft PR only, no staging (self-host only). Overrides: skip CodeRabbit and Playwright (list under "Before main").

## Research findings (what the install creates, from the code)

- Box: compose project `sam-selfhost` (`deploy/selfhost/docker-compose.yml`), volumes celld-data,
  egress-fence-attestation, caddy-data, caddy-config, objectstore-data (the local-store bucket), images
  built by compose; `.state/` (key-agent bundles + kek + choice.json, platform keys/secrets for legacy,
  gateway.env, project/, bin/, go-cache/, mail collector files, docker-proxy dir); `.env`; local backups
  (`deploy/selfhost/backups/<time>`, `backup-lib.ts:runBackup`).
- Object store: fleet bucket objects under CELLD_BUCKET prefix (celld state, deploy versions, vm-agent
  releases, hosted git). Bundled store bucket is created by `objectstore/init.sh` and lives in a volume.
- Cloud via bootstrap: pool, provider, node SA + 2 project bindings + workloadIdentityUser binding on the
  SA (not recorded, removed with the SA), key ring, key, key grant (`gcp-bootstrap.sh`, recorded).
- Cloud at runtime (app in celld): node VMs labelled managed/installation/env/node/role
  (`node-provider-labels.ts`, `gcp.ts:createVM`), boot disks autoDelete=true, firewall rules with FIXED
  names `sam-allow-agent` / `sam-allow-app-routes` and no install identity (`gcp-firewall.ts`).
  Firewall rules cannot be proven this install's -> left for the operator (decision for Raphaël).
- Outside: GitHub App (manifest flow stores it in D1), wildcard DNS `*.SAM_DOMAIN`, MX
  `agents.SAM_DOMAIN` + `sam-smtp-in` port-25 rule (README, operator-made), box VM, its SA and bucket
  IAM binding (README, operator-made), AWS/Azure KMS keys (README commands, operator-made).
- Gap: SAM_INSTALLATION_ID (the VM ownership label) was only in the sealed keys / deploy vars; now
  recorded at deploy/--init time with the domain. Backups now recorded when taken.

## Checklist

- [ ] record install identity, box resources and backups at creation
- [ ] teardown core: inventory, plan, modes, flags, confirmation, ordering, resume, summary
- [ ] GCP adapter: VMs/disks with label proof + re-check, firewall (operator), bootstrap call, discovery
- [ ] bootstrap teardown `--keep-kms`
- [ ] tests through the CLI; live bucket test; discriminating refusal check
- [ ] README "Removing an install"
- [ ] security-auditor, CI green, draft PR, channel post
