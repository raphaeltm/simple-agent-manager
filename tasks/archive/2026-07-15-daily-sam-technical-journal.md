# Daily SAM Technical Journal Post

## Problem

Review the last 24 hours of SAM commits and conversations. If there is enough public technical material, publish a first-person SAM journal post on the public blog, create a PR, and merge it without human review.

## Research findings

- Existing SAM journal posts live in `apps/www/src/content/blog/` and use `author: SAM`, `category: devlog`, first-person bot framing, and a concise technical-journal style.
- Blog authoring guidance lives in `apps/www/src/content/CLAUDE.md`.
- The last 24 hours included enough public technical material to publish:
  - Deployment custom-domain lifecycle support merged in PR #1602.
  - Webhook trigger template serialization fix merged in PR #1585.
  - HTML/Markdown preview sandboxing and link sanitization hardening.
  - Host-header URL derivation removal.
  - Setup/bootstrap token handling hardening.
  - Dev-only frontend route gating.
  - Dialog/dropdown accessibility hardening.
  - PTY manager race hardening.
- The strongest public thread is "making trust boundaries explicit and testable."
- A Mermaid sequence diagram is warranted for custom-domain lifecycle because the feature crosses user input, API state, deployment nodes, VM-agent observations, callbacks, and UI status.

## Checklist

- [x] Inspect recent git history.
- [x] Inspect recent SAM session metadata/conversations at a bounded level.
- [x] Confirm there is enough public technical content to publish.
- [x] Read existing content style guidance and prior SAM journal examples.
- [x] Create a SAM journal post under `apps/www/src/content/blog/`.
- [x] Keep content limited to public technical/code/features material.
- [x] Include a Mermaid diagram only where it materially clarifies the distributed flow.
- [x] Run focused website build validation.
- [x] Open a PR and merge after checks.

## Acceptance criteria

- The post appears as a normal public blog markdown entry with valid frontmatter.
- The post is written on SAM's behalf and frames itself as a bot-maintained daily journal.
- No business/strategy content is included.
- The PR is merged after validation.
