# Deployment nodes provider-existence reconciliation cannot prove absent

## Problem

Provider-existence reconciliation (`apps/api/src/services/deployment-node-provider-existence.ts`,
PR [#2981](https://github.com/raphaeltm/simple-agent-manager/pull/2981)) only accepts a "not found"
through the node's pinned placement credential, because a not-found through any other credential
is also what a wrong-account lookup returns. A node whose placement credential was rotated,
re-saved or never pinned (legacy) is therefore always `credential_not_pinned`: if its VM is
deleted at the provider outside SAM, its app-route DNS records keep pointing at the released IP
(the subdomain-takeover gap of idea 01M81Z9P6QFX4M9Q83K2XKGZVR) until someone stops the
environment.

Two more classes are deliberately never released (#2981 review):

- **Scaleway** nodes: `getVM` and `listVMs` both treat a 404 from any zone as "nothing there"
  (`packages/providers/src/scaleway.ts`), so a systemic 404 would read every node as gone in both
  sources. They record `provider_unsupported`. Fix needs a Scaleway lookup in the node's own zone
  that fails closed on any non-not-found answer, without breaking orphan reconciliation's tolerance
  of zones an account cannot use.
- **Truncating inventories** (second-layer only, needs a false `getVM` null first): DigitalOcean
  and Vultr `listVMs` return a partial list past 4,000 / 5,000 instances, Infomaniak ignores
  `servers_links`, UpCloud reads one page. A "complete list or throw" option would make the
  confirming cross-check fully independent.

## Context

Found by the task-completion validator and security auditor on #2981 (2026-11-23). Every staging
deployment node checked that day was pinned; production volume unknown. Each such node records a
`provider_check_inconclusive` / `credential_not_pinned` decision at most once an hour.

## Acceptance Criteria

- [ ] Count of running deployment nodes stuck at `credential_not_pinned` is visible to operators
      (admin surface or an alert), from `node_lifecycle_decisions`
- [ ] A safe absence proof for these nodes is designed (for example: the owner's current
      credential proves it reads the same account by seeing another of the node's sibling
      instances, or re-pin on credential re-save when the account identity is provably unchanged)
- [ ] Tests cover rotated, re-saved and legacy credentials, with a wrong-account control
- [ ] Scaleway absence proof through the node's own zone, failing closed on a systemic 404
- [ ] `listVMs` complete-or-throw mode used by the confirming probe
