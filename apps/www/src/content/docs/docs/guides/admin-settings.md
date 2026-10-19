---
title: Dynamic admin settings
description: Change Phase 1 platform controls without redeploying the Worker.
---

Active, approved superadmins can use **Admin → Settings** to search and edit platform settings from a phone or desktop. This page covers the Phase 1 controls: GitHub, Google login, Google infrastructure and GitLab OAuth configuration; the ten Connector settings; anonymous trials; cron sweeps; Durable Object alarms; stalled-task classification; and the Collaboration limits for shared chats and comments. Other deployment and resource settings remain in their existing interfaces.

The editor shows each setting's effective value, code default and source. Secret fields show only whether a value is configured. Enter a replacement to change a secret; leaving a password field empty does not reveal or erase the current secret. Related OAuth client IDs and secrets must satisfy the existing provider validation together. Risky saves and resets require confirmation.

**Reset** removes the D1 override. It can expose a legacy environment or KV value, so it does not necessarily restore the code default. To choose the code default explicitly, save that value where the setting supports it. Search and category grouping do not change which settings a save affects.

Every mutation records the actor, time, affected setting and action in a value-free audit history. Saves use a revision: if another administrator or a legacy settings page changes configuration, refresh before retrying a conflicted edit. D1 configuration and audit updates are atomic. Operational re-enable also clears the existing emergency KV brake after the D1 commit. D1 and KV are not atomic: a timeout can leave re-enable propagation uncertain, and a multi-control enable can propagate only some KV updates. Reload and verify every effective control before retrying; an error does not imply rollback. A stale revision never clears a KV brake. A newer D1 disable remains effective even if an older enable finishes its KV update later.

## Collaboration

These limit [shared chats and comments](/docs/guides/collaboration/#work-together-in-a-chat).

| Setting                                          | Default | Range     | What it limits                                                                                     |
| ------------------------------------------------ | ------- | --------- | -------------------------------------------------------------------------------------------------- |
| `collaboration.sessionAccessMaxGrants`           | 10      | 1–100     | People one chat can be shared with at a time                                                       |
| `collaboration.commentMentionsMax`               | 10      | 1–50      | People one comment or reply can @mention                                                           |
| `collaboration.commentNotificationWindowSeconds` | 600     | 60–86,400 | Seconds during which further comments on one chat send each person no new **Comment** notification |

Lowering the share limit does not remove anyone's access. It only blocks new shares while a chat is at or above the limit.

## Storage and consistency

D1 `platform_settings` stores non-secret overrides. Existing encrypted credential storage continues to hold OAuth secrets; the editor, audit records and errors never return secret values. Bootstrap encryption and signing roots are not settings in this editor.

Resolution is D1 override first, then temporary legacy environment/KV compatibility, then the existing code default. Cron and alarm emergency KV disables are an independent veto: `false` or `disabled` still stops work even when D1 says enabled. Existing installations need no backfill and keep their effective configuration until an administrator changes it. Fresh installs retain their existing defaults, including anonymous trials disabled.

A save invalidates the saving Worker's caches immediately. Other Worker instances converge within at most one minute (operational/trial caches at most 30 seconds); shorter legacy OAuth, trial and operational cache settings, including zero to bypass caching, continue to apply; this is not globally instantaneous configuration. Admin reads request fresh data and report database failures instead of displaying defaults as authoritative state. Runtime controls apply their documented safe outage behavior; an observed disabled operational brake must not silently become enabled during an outage. Security and entitlement checks fail closed when authoritative configuration cannot be read safely.

## Deployment and rollback

The additive revision/audit migration does not change live setting values or copy environment/KV state into D1. Keep its tables when rolling back Worker code. Older code may read KV rather than the new D1 operational overrides: before promoting such code, deliberately reconcile and verify the current effective cron, alarm and trials values in their legacy KV keys. D1 and KV writes are not one atomic transaction. Do not assume a Worker rollback also rolls back configuration.

Runtime settings should be added to the typed registry rather than introduced as new environment tunables. Domains, resource bindings, encryption roots and token-signing roots remain bootstrap configuration. CI preserves the historical environment compatibility surface and requires a documented bootstrap exception for new scalar Worker environment fields or vars.
