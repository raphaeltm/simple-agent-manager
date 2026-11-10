# Self-host T5: close the SSRF exposure (guarded outbound fetch + celld egress fence)

Task 01M73HRQ579XPSW3WWPZ1FWPE8, coordinator 01M72KTXWD8FJ0Z7TXKN5GF20J. Branch
`sam/self-host-pass-2-1fwpe8`, draft PR into `sam/selfhost-pass-2`.

## Problem

On a celld box the API Worker shares the host network. Any approved user can store an
`openai-compatible` credential with any HTTPS `baseUrl`; the AI proxy passthrough POSTs there with
no `redirect` option and relays the body. An attacker server answering 302 to a loopback or
metadata URL gets the internal response back. Verified on celld 0.6.3: default fetch follows the
redirect (`res.redirected` stays false, `res.url` unchanged), `redirect: 'manual'` returns the 302.

## Research findings

- Inventory (full table goes in the PR): user-controlled hosts are the passthrough (#1) and web
  push endpoints (#4). Admin-controlled: LLM endpoint direct calls (4 sites, `redirect:'error'`),
  Mastra `ModelRouterLanguageModel` (no fetch hook; uses @ai-sdk/openai-compatible 2.0.87
  internally), GitLab host (`gitlabFetch`, follows redirects). Image resolver already guards
  (manual + per-hop) but has its own parallel classifier. Node agent fetches: platform host;
  reverse-tunnel forced `manual`. Operator env URLs (DoH, analytics, model catalog, codex refresh,
  pages) unchanged.
- `redirect: 'error'` is rejected by workerd ("use manual"); 'manual' works on workerd and celld.
- celld 0.6.3 has no Worker egress control; its GCS client is Apache `object_store`, which honours
  `GCE_METADATA_HOST`/`GCE_METADATA_IP` and formats `http://{host}/computeMetadata/v1/...`.
- Worker code and celld's storage client are one process: any network credential source celld
  can use, the Worker can reach. A fence can only separate by destination.
- Lease range validation against celld/frps/store ports is in T2 follow-up PR #2625; not duplicated.

## Checklist

Part A

- [x] network-hosts: one classifier (`classifyHost`) covering every IPv4/IPv6/name spelling
- [x] network-hosts: `guardedFetch` (pre-validate, redirect manual, per-hop revalidation, bounded hops)
- [x] Passthrough (3 fetches) through guardedFetch; save-time host check in composable-credentials
- [x] Use-time check in resolveProxyUpstream
- [x] LLM endpoint: `llm.openAICompatible.allowPrivateNetwork` opt-in; 4 direct sites through guardedFetch
- [x] Mastra operator model: openai-compatible model with guarded fetch
- [x] Web push: host check at save + guarded send
- [x] GitLab: guarded fetch
- [x] Image resolver: shared classifier (remove duplicate)
- [x] Tests: exploit regression through real route with real HTTP servers; classifier table;
      per-site guard tests (discriminating); public + opted-in local controls

Part B

- [x] nftables egress fence for celld uid (compose service, fails closed)
- [x] GCE metadata: token proxy with secret path prefix; direct metadata blocked
- [x] `pnpm selfhost:verify-fence` operator check
- [x] Deploy refuses R2_ACCESS_KEY_ID == fleet AWS_ACCESS_KEY_ID
- [x] Real-stack proof from Worker code (probe worker, not in product)
- [x] README: replace "no egress fence yet" gap

## Acceptance criteria

- The passthrough exploit test fails on the old code and passes with the fix.
- Forbidden targets fail from Worker code on a real celld box with the fence; allowed ones work.
- Legitimate public endpoints and an opted-in local model endpoint still work.

## Notes (implementation)

- Fence verdict is `reject with icmpx admin-prohibited`, not `drop`: measured on this workspace,
  a TCP SYN dropped in OUTPUT retransmits until connect() times out, which hung celld's start
  check. Reject gives an immediate "No route to host" (EHOSTUNREACH).
- celld's GCS client (Apache object_store in celld 0.6.3) honours GCE_METADATA_HOST including a
  path prefix: verified with the real binary against a fake metadata server via the proxy.
- When the token proxy is unreachable celld's own error chain contains the proxy URL with the
  secret (celld process log only). A Worker R2 call with storage down saw only
  `Error: write s3://bucket/key` (no cause chain). Residual documented in the PR.
- `pnpm selfhost:deploy --env-file X` through pnpm/tsx is intercepted (`--env-file` is a Node
  flag); pre-existing, the default path works. Not changed here.
- Reviewer fixes: see PR "Specialist Review Evidence".

