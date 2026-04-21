# Pulumi State Removed After Failed Teardown

## What Broke

Production redeploy attempted to create a fresh Pulumi stack while Cloudflare still had resources from a previous deployment. The visible failure was Cloudflare rejecting creation of the existing KV namespace:

```text
error creating workers kv namespace: a namespace with this account ID and title already exists (10014)
```

## Root Cause

The teardown workflow removed Pulumi stack state after selecting a stack, regardless of whether `pulumi destroy` actually deleted the Pulumi-managed resources. The unsafe guard lived on the `Remove Pulumi Stack` step in `.github/workflows/teardown.yml`.

Because `Pulumi Destroy` uses `continue-on-error: true`, a failed destroy could leave Cloudflare resources in place while the later stack-removal step still ran `pulumi stack rm "$STACK" --yes --force`.

## Timeline

- 2026-04-21: A production deploy first failed with Cloudflare authentication errors during `pulumi up`.
- 2026-04-21: After credentials were corrected, a later deploy failed because Cloudflare resources already existed but Pulumi was creating a new stack.
- 2026-04-21: The teardown workflow was inspected and found to remove stack state without requiring successful destroy.

## Why It Wasn't Caught

The workflow had no regression test for the destructive-state invariant: Pulumi state must not be removed unless the provider-side destroy succeeded.

The teardown summary did report the destroy status, but the stack-removal step was independently gated and did not depend on that status.

## Class Of Bug

This is a destructive cleanup ordering bug: state tracking was deleted before the external system was confirmed clean.

## Process Fix

Workflow changes that delete state, metadata, lock files, or other recovery handles after external resource cleanup must add an explicit success gate tying the state deletion to the cleanup step's success output. This rule is now documented in `.claude/rules/02-quality-gates.md`.
