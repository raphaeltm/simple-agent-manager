# Infrastructure Items Are Merge-Blocking

## Rule: Infrastructure and Configuration Phases Cannot Be Deferred

If your task file has an Infrastructure, Configuration, or Deployment phase, **every item in that phase must be checked off before you may create a PR**. These items cannot be deferred to follow-up tasks.

### Why This Rule Exists

Infrastructure items (CORS rules, credential forwarding, DNS records, lifecycle policies, bucket configuration) are invisible deployment dependencies. Code that depends on them will:
- Pass all unit tests (mocks don't need CORS)
- Pass all integration tests (Miniflare doesn't need real bucket config)
- Render correctly in the UI (the button appears even if the upload fails)
- Fail silently in production (browser CORS errors, missing credentials, 404s from misconfigured routes)

The R2 upload saga shipped three bugs because infrastructure items were listed in research, added to the checklist, and then archived without completion. Each bug required a separate follow-up PR to fix.

### What Counts as Infrastructure

Any checklist item that involves:
- **CORS configuration** on external services (R2, S3, CDN)
- **Credential forwarding** in deployment pipelines (env vars in CI workflows)
- **DNS records** or TLS certificates
- **Bucket/storage lifecycle rules** or policies
- **IAM bindings** or permission grants
- **Wrangler bindings** or Worker configuration
- **Cloud-init templates** or VM provisioning config

### Enforcement

1. **Before creating a PR**: Scan the task file for any phase with "Infrastructure", "Configuration", "Deployment", or "Setup" in the name. Every item must be `[x]`.
2. **If an infrastructure item cannot be completed**: Do NOT merge. Push the branch, document what's blocked and why, and let a follow-up task handle it.
3. **"Document it for self-hosters" is not completion**: If the deployment pipeline needs a step, automate it. Documentation alone does not count as completing an infrastructure item — the R2 CORS configuration was documented in `self-hosting.md` but never automated, and the feature shipped broken.

### Quick Check Before PR

- [ ] Every infrastructure/configuration checklist item is `[x]`
- [ ] Every new credential/secret is forwarded in the deployment workflow
- [ ] Every external service configuration (CORS, lifecycle, IAM) is automated in the pipeline
- [ ] No infrastructure item is deferred to a backlog task
