# Debug Package Tar Write Too Long

## Problem

During staging validation on 2026-05-11, downloading a node debug package succeeded overall, but the VM agent logged a tar writer warning for `syslog.log`:

```text
debug-package: failed to write file to tar name="syslog.log" error="archive/tar: write too long"
```

Evidence:

- Node: `01KRC3MDN3ZFMCEX7V1G39NEWR`
- Debug package endpoint: `GET /api/nodes/:id/debug-package`
- Affected file: `syslog.log`

## Context

This was discovered while validating Cloudflare managed Containers Registry devcontainer cache behavior. The debug package still downloaded and contained useful evidence, but a partial/malformed diagnostic source can hide important VM logs during future incidents.

## Acceptance Criteria

- [ ] Reproduce the debug package generation path with a large or actively growing `syslog.log`.
- [ ] Fix tar entry sizing so files that change while being archived do not produce `archive/tar: write too long`.
- [ ] Ensure debug package generation either snapshots files before archiving or gracefully truncates with clear metadata.
- [ ] Add regression coverage for changing log files during debug package creation.
