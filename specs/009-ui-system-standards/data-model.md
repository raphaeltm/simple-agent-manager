# Data Model: Unified UI System Standards

## Overview

This model describes governance and reusable UI-system entities required to deliver:
- A unified visual standard
- A shared component library across product surfaces
- Agent-consumable rules and compliance checks

## Entities

### 1. UIStandard

Represents the canonical versioned UI standard.

| Field | Type | Required | Description |
|------|------|----------|-------------|
| id | string | Yes | Unique identifier for the standard record |
| version | string | Yes | Human-readable version (for example: `v1.0`) |
| status | enum | Yes | `draft`, `review`, `active`, `deprecated` |
| name | string | Yes | Standard title |
| visualDirection | string | Yes | Summary of visual intent, including green-forward direction |
| mobileFirstRulesRef | string | Yes | Reference to responsive/mobile policy section |
| accessibilityRulesRef | string | Yes | Reference to accessibility policy section |
| createdAt | datetime | Yes | Record creation timestamp |
| updatedAt | datetime | Yes | Last update timestamp |
| ownerRole | string | Yes | Role accountable for updates and approvals |

Validation rules:
- Exactly one `active` UIStandard version at a time.
- `version` must be unique.
- `status=active` requires linked checklist and instruction-set versions.

### 2. ThemeTokenSet

Defines semantic visual tokens used by shared components.

| Field | Type | Required | Description |
|------|------|----------|-------------|
| id | string | Yes | Unique token set identifier |
| standardId | string | Yes | Parent `UIStandard.id` |
| tokenNamespace | string | Yes | Namespace (color, typography, spacing, radius, elevation, motion) |
| tokenName | string | Yes | Semantic token key |
| tokenValue | string | Yes | Value assigned to the token |
| mode | enum | Yes | `default`, `high-contrast`, `reduced-motion` |
| isDeprecated | boolean | Yes | Token deprecation marker |

Validation rules:
- `tokenName` must be unique within (`standardId`, `tokenNamespace`, `mode`).
- Token values must not be empty.
- Deprecated tokens require a replacement reference.

### 3. ComponentDefinition

Represents a shared, reusable component contract.

| Field | Type | Required | Description |
|------|------|----------|-------------|
| id | string | Yes | Unique component identifier |
| standardId | string | Yes | Parent `UIStandard.id` |
| name | string | Yes | Component name |
| category | enum | Yes | `input`, `navigation`, `feedback`, `layout`, `display`, `overlay` |
| supportedSurfaces | array | Yes | Target surfaces (`control-plane`, `agent-ui`) |
| requiredStates | array | Yes | Must include core states required by spec |
| usageGuidance | string | Yes | Human-readable usage rules |
| accessibilityNotes | string | Yes | Keyboard/focus/labeling expectations |
| mobileBehavior | string | Yes | Mobile-first behavior requirements |
| desktopBehavior | string | Yes | Desktop enhancement guidance |
| status | enum | Yes | `draft`, `ready`, `deprecated` |

Validation rules:
- `requiredStates` must include: `default`, `focus`, `active`, `disabled`, `loading` (when actionable).
- `status=ready` requires accessibility and responsive guidance fields populated.
- New product UI work should reference a `ready` component unless exception approved.

### 4. ComplianceChecklist

Defines the review checklist used for UI pull-request approval.

| Field | Type | Required | Description |
|------|------|----------|-------------|
| id | string | Yes | Unique checklist id |
| standardId | string | Yes | Parent `UIStandard.id` |
| version | string | Yes | Checklist version identifier |
| items | array | Yes | Ordered checklist items with pass/fail criteria |
| appliesTo | array | Yes | Scope (`human-authored`, `agent-authored`) |
| isActive | boolean | Yes | Active checklist flag |
| publishedAt | datetime | Yes | Publish timestamp |

Validation rules:
- Exactly one active checklist per active standard.
- Each item must have an unambiguous pass condition.
- Checklist must include mobile, accessibility, and desktop sections.

### 5. AgentInstructionSet

Represents the machine-consumable UI guidance used by coding agents.

| Field | Type | Required | Description |
|------|------|----------|-------------|
| id | string | Yes | Unique instruction-set id |
| standardId | string | Yes | Parent `UIStandard.id` |
| version | string | Yes | Version identifier |
| instructionBlocks | array | Yes | Structured rules (do/don't, layout, accessibility, style) |
| examplesRef | string | No | Link to canonical examples |
| requiredChecklistVersion | string | Yes | Associated compliance checklist version |
| isActive | boolean | Yes | Active instruction-set flag |

Validation rules:
- Must include explicit mobile and desktop layout guidance.
- Must include non-negotiable accessibility rules.
- Must map to the active checklist version.

### 6. ComplianceRun

Captures evaluation outcome for a UI change.

| Field | Type | Required | Description |
|------|------|----------|-------------|
| id | string | Yes | Unique run identifier |
| standardId | string | Yes | Active `UIStandard.id` used for evaluation |
| checklistVersion | string | Yes | Checklist version used for evaluation |
| authorType | enum | Yes | `human`, `agent` |
| changeRef | string | Yes | PR/commit/change identifier |
| status | enum | Yes | `queued`, `running`, `passed`, `failed`, `waived` |
| findings | array | No | Validation findings and notes |
| reviewedBy | string | No | Reviewer identifier |
| completedAt | datetime | No | Completion timestamp |

Validation rules:
- `passed` or `failed` requires `completedAt`.
- `waived` requires linked `ExceptionRequest`.

### 7. ExceptionRequest

Documents approved departures from shared standards.

| Field | Type | Required | Description |
|------|------|----------|-------------|
| id | string | Yes | Unique exception id |
| standardId | string | Yes | Applicable standard version |
| requestedBy | string | Yes | Requestor identifier |
| rationale | string | Yes | Business/technical justification |
| scope | string | Yes | Affected component/screen/flow |
| expirationDate | date | Yes | Date after which exception is invalid |
| approver | string | Yes | Approval authority |
| status | enum | Yes | `pending`, `approved`, `rejected`, `expired` |

Validation rules:
- `approved` requires approver and expiration date.
- Expired exceptions cannot be reused for new changes.

### 8. MigrationWorkItem

Tracks migration of existing screens/patterns to the unified standard.

| Field | Type | Required | Description |
|------|------|----------|-------------|
| id | string | Yes | Unique migration item id |
| surface | enum | Yes | `control-plane`, `agent-ui` |
| targetRef | string | Yes | Screen/flow identifier |
| priority | enum | Yes | `high`, `medium`, `low` |
| status | enum | Yes | `backlog`, `planned`, `in-progress`, `completed`, `verified` |
| owner | string | Yes | Accountable owner |
| dueMilestone | string | No | Target release/milestone |
| notes | string | No | Additional context |

Validation rules:
- High-priority items require owner and due milestone.
- `verified` requires a passed compliance run.

## Relationships

- `UIStandard` 1-to-many `ThemeTokenSet`
- `UIStandard` 1-to-many `ComponentDefinition`
- `UIStandard` 1-to-many `ComplianceChecklist`
- `UIStandard` 1-to-many `AgentInstructionSet`
- `UIStandard` 1-to-many `ComplianceRun`
- `UIStandard` 1-to-many `ExceptionRequest`
- `UIStandard` 1-to-many `MigrationWorkItem`
- `ComplianceRun` may reference one `ExceptionRequest` when status is `waived`

## State Transitions

### UIStandard.status

`draft` -> `review` -> `active` -> `deprecated`

Rules:
- Only `review` versions can be promoted to `active`.
- Promoting a version to `active` automatically deactivates previous active version.

### ComponentDefinition.status

`draft` -> `ready` -> `deprecated`

Rules:
- `ready` requires completed usage/accessibility/responsive guidance.

### ComplianceRun.status

`queued` -> `running` -> (`passed` | `failed` | `waived`)

Rules:
- Terminal states are immutable.

### ExceptionRequest.status

`pending` -> (`approved` | `rejected`) -> `expired`

Rules:
- `expired` is time-based and final.

### MigrationWorkItem.status

`backlog` -> `planned` -> `in-progress` -> `completed` -> `verified`

Rules:
- Regressions may move `verified` back to `in-progress` with new findings.
