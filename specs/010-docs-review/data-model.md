# Data Model: Documentation Review and Update

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Date**: 2026-02-07

## Entity Definitions

### Document

Represents a markdown file under review.

| Field | Type | Description |
|-------|------|-------------|
| path | string | Absolute file path relative to repository root |
| category | enum | Classification: `root`, `adr`, `architecture`, `guide`, `research`, `package-readme`, `governance`, `template`, `agent-config` |
| targetAudience | enum | Primary audience: `all`, `developer`, `contributor`, `end-user`, `ai-agent`, `security-engineer`, `devops` |
| grade | enum | Quality assessment: `A` (exemplary), `B` (minor issues), `C` (incomplete), `D` (needs major rewrite) |
| status | enum | Review status: `pending`, `reviewed`, `updated`, `no-change-needed` |
| wordCount | number | Approximate word count |
| lastModified | date | Last git modification date |

### Issue

Represents a problem found during documentation review.

| Field | Type | Description |
|-------|------|-------------|
| documentPath | string | Path of the affected document |
| severity | enum | `critical` (blocks understanding), `major` (misleading), `minor` (cosmetic), `info` (suggestion) |
| type | enum | Issue classification (see Issue Types below) |
| location | string | Line number or section reference |
| description | string | What the issue is |
| suggestedFix | string | How to resolve the issue |

### Issue Types

| Type | Description | Severity Range |
|------|-------------|----------------|
| `obsolete-reference` | References removed/deprecated feature | critical-major |
| `broken-link` | Internal link to non-existent file | critical |
| `wrong-endpoint` | API endpoint doesn't match code | critical |
| `missing-content` | Required section or information is absent | major |
| `outdated-structure` | File/directory listings don't match reality | major |
| `placeholder-inconsistency` | Inconsistent placeholder patterns | minor |
| `audience-mismatch` | Content tone/depth wrong for target audience | minor |
| `formatting-issue` | Markdown formatting problems | minor |
| `missing-disclaimer` | Historical document without archival notice | major |

### Review Report

Aggregated output from the review process.

| Field | Type | Description |
|-------|------|-------------|
| totalDocuments | number | Total documents reviewed |
| issuesByGrade | map | Count of documents per grade |
| issuesBySeverity | map | Count of issues per severity |
| documentsChanged | list | Documents that were modified |
| documentsUnchanged | list | Documents requiring no changes |

## Document Categories

```
Root Level (5 files)
├── README.md                    → all audiences
├── AGENTS.md                    → developers, AI agents
├── CLAUDE.md                    → AI agents
├── ROADMAP.md                   → all audiences
└── CONTRIBUTING.md              → contributors

ADRs (4 files)
├── 001-github-app-over-oauth    → developers
├── 001-monorepo-structure       → developers
├── 002-stateless-architecture   → architects [SUPERSEDED]
└── 003-ui-system-stack          → frontend devs

Architecture (3 files)
├── cloudcli.md                  → developers [DEPRECATED]
├── credential-security.md       → security engineers
└── secrets-taxonomy.md          → security engineers

Guides (9 files)
├── agent-preflight-behavior     → AI agents, developers
├── deployment-troubleshooting   → devops
├── getting-started              → new users [NEEDS REWRITE]
├── local-development            → developers
├── local-system-smoke-tests     → QA
├── mobile-ux-guidelines         → frontend devs
├── self-hosting                 → end users
├── ui-agent-guidelines          → AI agents
└── ui-standards                 → designers

Research (6 files)
├── README.md                    → developers [HISTORICAL]
├── ai-agent-optimizations       → developers [HISTORICAL]
├── architecture-notes           → architects [HISTORICAL]
├── browser-terminal-options     → architects [HISTORICAL]
├── dns-security-persistence     → devops [HISTORICAL]
└── multi-tenancy-interfaces     → developers [HISTORICAL]

Other (4 files)
├── packages/ui/README.md        → developers
├── .specify/memory/constitution → all
├── .github/pull_request_template → contributors
└── assets/fonts/chillax/README  → N/A (third party)
```

## State Transitions

```
Document Review Flow:
  pending → reviewed → no-change-needed
  pending → reviewed → updated

Issue Resolution Flow:
  identified → fix-applied → verified
  identified → deferred (with justification)
```
