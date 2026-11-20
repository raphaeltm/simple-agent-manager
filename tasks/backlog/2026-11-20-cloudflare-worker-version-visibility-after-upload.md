# Investigate Cloudflare Worker version visibility after upload

## Evidence
During inbox backend PR #2940 staging2 verification, Deploy Staging runs44725622257 and44735580116 exited after successful Worker upload with Cloudflare100146 on GET of the just-returned version ID. Intermediate reviewed-candidate deployments44729052331 and44732207791 passed.

For run44735580116, uploaded version940f75fe-cf24-49c2-8041-cd6e4ec7e8b0 returned404/100146 through the direct CF API at12:40:55 and12:41:52UTC on2026-11-20. At12:41:52, the deployment API simultaneously reported that exact version at100%, annotation commit:a5ee1be1f11f7bedfce4b6ed15290c363cc452dd, deployment9fc83e51-b3cc-4e29-9ac0-4036f78bc16f (created12:39:23UTC). The versions list omitted that version. Earlier inspection at12:40:55 still returned the previous deployment. Read-only evidence is recorded in managed execution jobs sx-08adcb430ee7b18715a4ab212fb3929ec2fd0726452df9711fc00ad55d834d3a and sx-0f290061498ee533be367c035ad69648d3fb9049b47a15482489a2a6f3de2e70.

This establishes inconsistent endpoint visibility; its cause is unconfirmed. No direct Worker mutation or migration bypass was used. Existing backend release gates still require a green pipeline.

## Work
- [ ] Trace Wrangler's failing post-upload read and compare version/deployment API behavior; determine whether vendor indexing, SDK sequencing or another cause explains it.
- [ ] If justified by evidence, handle only the known transient case with a bounded identity-preserving retry through the canonical deployment pipeline; retain unrelated failures.
- [ ] Add discriminating fault-injection tests and prove an unrelated error remains fatal.
- [ ] Verify a normal deployment and document any remaining vendor limitation; avoid repeated provisioning or unbounded redeploy loops.
