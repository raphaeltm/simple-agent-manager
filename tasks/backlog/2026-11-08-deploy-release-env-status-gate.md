# Gate Node-Scoped Deployment Secret Callbacks on Environment Lifecycle

## Problem

`GET /api/nodes/:id/deployment-env` and `GET /api/nodes/:id/deploy-release`
(`apps/api/src/routes/deploy-release-callback.ts`) return decrypted interpolation env, compose
secrets and minted registry pull credentials to a node-scoped callback token. They check that:

- the node is not terminal (once, before decrypting), and
- the environment is bound to the node and owned by the node's owner.

They do not read `deployment_environments.status`, and they do not re-check the node or
environment immediately before responding. `GET /:id/deploy-routes` does read the status.

As a result, an environment in `stopping`, `stopped`, `deleting` or `deleted` that is still bound to
a live node can keep fetching its secrets until the binding is cleared.

## Context

Found by the callback-sink inventory for task `01M6Y0DAXRD0S56125X2TQA7RF` (workspace credential
revocation, 2026-11-08). It is out of scope there because these are deployment-node credentials,
not workspace credentials.

A gate needs deployment-domain verification first. A node may legitimately fetch a release while
the environment is `starting`, and `error`-recovery releases arrive while the status is `error`
(`AGENT_DEPLOYABLE_ENVIRONMENT_STATUSES`; see apps/api rule 71, "The Same Bug in a Status Gate").

## Acceptance Criteria

- [ ] List every environment status in which a node legitimately calls `deployment-env` and
      `deploy-release`, and refuse the others with a designed 410.
- [ ] Re-read the node and environment state immediately before secrets leave (rule 49).
- [ ] Real-SQL tests: each refused status, each admitted status as an owner control, and a
      node that becomes terminal mid-request.
