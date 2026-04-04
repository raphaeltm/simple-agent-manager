# VM Agent Binary Refresh for Staging Tests

## Rule: Delete All Nodes Before Testing VM Agent Changes on Staging

When a PR modifies `packages/vm-agent/` and you need to verify the changes on staging, you MUST follow this exact sequence:

1. **Delete all existing nodes** on staging (via API or UI) before deploying
2. **Deploy to staging** (which builds and uploads the new VM agent binary to R2)
3. **Test in a new project chat** (which provisions a fresh node that downloads the latest binary)

### Why This Rule Exists

VM agent binaries are downloaded once during a node's cloud-init provisioning. Adding new workspaces to an existing node reuses the same binary. If you deploy a VM agent change and then test against an existing node, you are testing against the **old** binary — not your changes. This has caused repeated confusion where the Worker-side fix appeared to not work because the VM agent on the existing node didn't have the corresponding change.

### Common Mistake

1. Make VM agent code change
2. Deploy to staging (new binary uploaded to R2)
3. Test against existing workspace on existing node
4. See old behavior, conclude the fix doesn't work
5. Waste hours debugging a non-issue

The existing node still runs the old binary. Your new binary is in R2 but no running node has downloaded it.

### Correct Procedure

```bash
# 1. Delete all nodes (this also cleans up workspaces)
#    Use Playwright or the API to delete each node

# 2. Deploy to staging
gh workflow run deploy-staging.yml --ref <branch>
# Wait for deployment to succeed

# 3. Test via a new project chat
#    Submit a task or start a chat — this provisions a fresh node
#    The fresh node downloads the latest binary from R2 during cloud-init
```

### When This Applies

This rule applies whenever:
- You modify any file in `packages/vm-agent/`
- You need to verify the VM agent behavior on staging (not just the Worker side)
- You are debugging an issue that involves both the Worker and the VM agent

### Exception

If the change is Worker-only (`apps/api/`) and does not require VM agent changes, you do not need to delete nodes — the Worker deploys independently and takes effect immediately.
