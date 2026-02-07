# Metrics Plan: Unified UI System Standards

## Objective

Track whether the new shared UI system improves consistency, usability, and delivery quality.

## Metrics

1. Shared component adoption
   - Definition: percent of repeated UI patterns using `@simple-agent-manager/ui`
   - Target: >= 80% by two release cycles

2. Mobile usability completion
   - Definition: core task completion without horizontal scroll or zoom at 320px
   - Target: >= 90%

3. Desktop usability completion
   - Definition: core task completion without navigation confusion on desktop layouts
   - Target: >= 90%

4. UI PR checklist pass efficiency
   - Definition: percent of UI PRs passing checklist within two review rounds
   - Target: >= 95%

5. Design-related rework rate
   - Definition: PR revisions caused by UI standard violations
   - Target: 30% reduction vs baseline

## Data Collection

- PR metadata and checklist evidence from GitHub pull requests.
- QA validation outcomes from mobile/desktop acceptance sessions.
- Screen/component inventory from migration work item tracking.

## Reporting Cadence

- Weekly: migration progress and checklist pass rates
- Per release: adoption and usability outcomes
- Quarterly: trend review and standard updates
