# Phase 0: Technical Research

**Feature**: Agent OAuth & Subscription Authentication
**Date**: 2026-02-09

## Decision Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Storage Model** | Two-row model | Allows API key + OAuth token to coexist, cleanly separates credential types |
| **Active Tracking** | Explicit `is_active` column | Clear which credential is currently in use, supports toggle UI |
| **Database Changes** | Add `credential_kind` and `is_active` columns | Non-breaking, backward-compatible extension |
| **Unique Constraint** | Per (user, agent, kind) | Prevents duplicate credentials of same type while allowing different types |
| **Migration Strategy** | Incremental ALTER TABLE | Safe rollback, existing data preserved with defaults |
| **Encryption** | No changes needed | Existing AES-GCM per-credential encryption works perfectly |

## Research Findings

### 1. Current Credential Storage Architecture

The existing system stores agent API keys in a `credentials` table with:
- Unique constraint: ONE credential per (user_id, credential_type, agent_type)
- Encryption: AES-256-GCM with unique IV per credential
- Discriminator: `credential_type` distinguishes cloud-provider vs agent-api-key

**Key Finding**: The unique index currently prevents storing both API key and OAuth token for the same agent. This must be modified to support dual credentials.

### 2. Dual Credential Storage Approaches

#### Option A: Two-Row Model (SELECTED)
- Add `credential_kind` column (`api-key` vs `oauth-token`)
- Add `is_active` column to track which is in use
- Modify unique index to allow one of each kind
- **Benefits**: Clean queries, normalized schema, extensible
- **Tradeoffs**: Slightly more complex queries (filter by is_active)

#### Option B: Single-Row JSON Model (REJECTED)
- Store array of credentials in JSON column
- **Rejected because**: SQLite lacks native arrays, harder to enforce constraints, complex encryption

#### Option C: Separate Tables (REJECTED)
- Create new `oauth_credentials` table
- **Rejected because**: Duplicates encryption logic, complicates API routes

### 3. Active Credential Management

**Requirement**: Exactly one active credential per agent at any time.

**Implementation Strategy**:
1. Database level: `is_active` boolean column with application logic enforcement
2. Auto-activation: New credentials automatically become active (FR-014)
3. Query pattern: Filter by `is_active = true` when fetching for VM Agent

**Alternatives Considered**:
- Database trigger to enforce one-active constraint (overly complex for SQLite)
- Separate active_credential_id reference (requires additional join)

### 4. Environment Variable Injection

The VM Agent needs to know which environment variable to set:
- API Key: `ANTHROPIC_API_KEY`
- OAuth Token: `CLAUDE_CODE_OAUTH_TOKEN`

**Solution**: Include `credentialKind` in the agent-key response so VM Agent can determine correct env var.

### 5. Migration Safety

**Non-Breaking Changes**:
- Adding columns with defaults (`credential_kind = 'api-key'`, `is_active = true`)
- Existing credentials continue working without modification
- New unique index is additive, doesn't break existing constraint

**Rollback Plan**:
1. Drop new indexes (fast)
2. Drop new columns if needed (requires migration but safe)
3. Application reverts to ignoring new fields

## Implementation Order

1. **Database Migration** (0006_dual_credentials_oauth_support.sql)
   - Add columns with defaults
   - Create new indexes
   - Mark existing credentials as active

2. **API Updates** (credentials.ts, workspaces.ts)
   - Handle credential_kind in save/update
   - Implement active credential switching
   - Return credential type to VM Agent

3. **UI Components** (AgentKeyCard.tsx, CredentialToggle.tsx)
   - Toggle interface for switching active credential
   - Show both credentials with active indicator

4. **VM Agent** (gateway.go, process.go)
   - Receive credential kind from API
   - Inject correct environment variable based on kind

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Migration fails | Low | High | Test in staging first, have rollback SQL ready |
| Both credentials inactive | Low | Medium | Application logic ensures one is always active |
| Wrong env var injected | Low | High | Integration tests for both credential types |
| OAuth token in logs | Medium | High | Continue never logging decrypted credentials |

## Open Questions Resolved

1. **Q: Should we validate OAuth token format?**
   - **A: No** - Tokens are opaque strings per spec. Agent binary handles validation.

2. **Q: How to handle credential deletion when it's active?**
   - **A: If other credential exists, auto-activate it. If not, delete allowed (user has no auth).**

3. **Q: Should we support more than 2 credentials per agent?**
   - **A: No** - Spec explicitly states one API key + one OAuth token max.

## Next Steps

Proceed to Phase 1: Design & Contracts with this two-row model approach.