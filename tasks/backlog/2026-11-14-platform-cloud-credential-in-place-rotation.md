# Rotate a platform cloud credential without losing the installation pool's choices

## Problem

A platform (installation) cloud credential has no in-place secret update. `POST
/api/admin/platform-credentials` creates a row and `DELETE /:id` removes it
(`apps/api/src/routes/admin-platform-credentials.ts`); `PATCH` changes only the label and the
enabled flag. Rotating a key is therefore "add the new one, delete the old one".

`capacity_sources.platform_credential_id` cascades from `platform_credentials` (migration 0125),
so the delete removes the source and every pool candidate built on it: the choices a superadmin
or user made for that account disappear, and the replacement source's options start switched off
(`initialStatusForProviderOffering`). Placement on that provider stops until someone picks
machines again. Nodes placed from the old source stay reapable since
`sam/cloud-credential-re-save-hhmt7p` (released-source provenance).

The same happens for a user or project disconnect followed by a reconnect. Whether choices should
survive that is a product decision (idea `01M76T4XXVQS1TX8VQM2BRPWFG`).

## Context

Found while fixing the GCP re-save cascade (task `01M7BNEQ5MYA2NCG54EFHHMT7P`). User and project
saves already update the row in place, and after that fix so does the user GCP save.

## Acceptance criteria

- [ ] A superadmin can replace a platform cloud credential's secret in place (validated like
      create), keeping its id, so the capacity source and its pool choices survive.
- [ ] The admin UI offers it next to the existing credential.
- [ ] A worker test on the real migration chain proves the source, its active candidates and a
      placed node's `capacity_source_id` survive the rotation, and placement still resolves.
