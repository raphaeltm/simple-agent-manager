# Refresh the desktop hero marketing capture

## Problem

`apps/web/tests/playwright/marketing-shots-platform.spec.ts` › `sam-hero-live-session` no longer
passes against the current app: it waits for `Read payments/webhooks/refund_handler.py` to be
visible, but the chat now groups tool calls ("3 tool calls · running Bash: …") and that row is
collapsed inside the group. The committed `sam-hero-live-session(-light).png` therefore shows the
older, ungrouped tool rows, while the phone capture (`sam-hero-phone`) shows the current grouping.

## Context

Found 2026-10-15 while capturing the phone source for the glasshouse homepage hero
(`tasks/archive/2026-10-14-glasshouse-homepage-a2.md`). The marketing capture specs are not part
of CI (only `*audit.spec.ts` runs), so the stale assertion went unnoticed.

The homepage hero layers are cropped from this capture by `apps/www/scripts/build-hero-layers.ts`
(window geometry and streaming steps are measured on the current image).

## Acceptance Criteria

- [ ] The `sam-hero-live-session` capture passes against the current chat UI (assert the grouped
      tool row, or expand the group, instead of the individual Read row)
- [ ] Both themes re-captured (`MARKETING_SHOTS=1`, then `MARKETING_THEME=light`)
- [ ] `pnpm --filter @simple-agent-manager/www build:hero-layers` re-run, with the `desktop` window
      geometry and `steps` in the script re-measured against the new image
- [ ] `pnpm --filter @simple-agent-manager/www optimize:features` re-run for the feature page copy
- [ ] Homepage hero checked visually in both themes (streaming beats reveal whole rows)
