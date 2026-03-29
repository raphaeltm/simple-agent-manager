# Task Submission File Attachments via R2 Presigned Uploads

## Problem

Users cannot attach files when submitting a new task because no workspace exists yet at submission time. The existing file upload infrastructure (`POST /workspaces/{id}/files/upload`) requires an active workspace with a running container. This feature enables file attachments at task submission time by uploading to R2 first, then copying into the workspace after provisioning.

## Research Findings

### Existing Infrastructure
- **R2 bucket**: Single shared bucket `sam-{stack}-assets` bound as `R2` in wrangler.toml
- **R2 usage**: Agent binaries (`agents/*`) and TTS audio cache (`tts/{userId}/*`)
- **No presigned URL infrastructure**: No S3-compatible credentials, no presigner library
- **VM Agent file upload**: `POST /workspaces/{id}/files/upload` accepts multipart, writes via `docker exec tee` to `.private/`
- **API file proxy**: `POST /api/projects/:id/sessions/:sessionId/files/upload` resolves workspace and proxies

### Key Types
- `SubmitTaskRequest` in `packages/shared/src/types.ts` (line ~618) — no attachment field
- `TaskRunConfig` in `apps/api/src/durable-objects/task-runner.ts` (line ~102) — no attachment field
- Task Runner execution steps: `node_selection → node_provisioning → node_agent_ready → workspace_creation → workspace_ready → agent_session → running`

### UI Patterns
- `TaskSubmitForm.tsx` — text-only form, no file upload
- `FollowUpInput` in `ProjectMessageView.tsx` — has paperclip file upload pattern with hidden input, progress state
- `uploadSessionFiles()` in `api.ts` — FormData multipart upload pattern

### Design Decisions
- **Presigned URLs via S3-compatible API**: Need `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
- **New Worker secrets**: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CF_ACCOUNT_ID`
- **Same R2 bucket**: Use `temp-uploads/` prefix in the existing bucket (no new bucket needed)
- **R2 CORS**: Needs bucket-level CORS for direct browser uploads
- **Task Runner injection**: New `attachment_transfer` step between `workspace_ready` and `agent_session`

## Implementation Checklist

### Phase A: Shared Types
- [ ] A1. Add `TaskAttachment` type to `packages/shared/src/types.ts`
- [ ] A2. Add `attachments?: TaskAttachment[]` to `SubmitTaskRequest`
- [ ] A3. Add attachment config constants (max file size, max files, max batch size, presign expiry)
- [ ] A4. Build shared package

### Phase B: API — Presigned URL Generation
- [ ] B1. Add R2 S3 credential env vars to `Env` interface (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CF_ACCOUNT_ID`)
- [ ] B2. Install `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` in api package
- [ ] B3. Create `apps/api/src/services/attachment-upload.ts` — S3Client setup, presigned URL generation, R2 HEAD validation
- [ ] B4. Create `apps/api/src/routes/tasks/upload.ts` — `POST /api/projects/:id/tasks/request-upload` endpoint
- [ ] B5. Register the new route in the tasks router
- [ ] B6. Add configurable env vars: `ATTACHMENT_UPLOAD_MAX_BYTES`, `ATTACHMENT_UPLOAD_BATCH_MAX_BYTES`, `ATTACHMENT_MAX_FILES`, `ATTACHMENT_PRESIGN_EXPIRY_SECONDS`

### Phase C: API — Task Submit Validation
- [ ] C1. Modify `apps/api/src/routes/tasks/submit.ts` to accept and validate `attachments` field
- [ ] C2. Validate each attachment: R2 HEAD check (existence + size match + userId ownership via key prefix)
- [ ] C3. Store attachment metadata with task in D1 (add `attachments` JSON column to tasks table or create junction table)

### Phase D: Task Runner — Attachment Transfer
- [ ] D1. Add `attachments?: TaskAttachment[]` to `TaskRunConfig`
- [ ] D2. Add `attachment_transfer` step to execution step enum (between `workspace_ready` and `agent_session`)
- [ ] D3. Implement attachment transfer: R2 GET → POST to VM agent file upload endpoint
- [ ] D4. Augment agent initial prompt with attached file list
- [ ] D5. Eager R2 cleanup after successful transfer (delete keys)

### Phase E: Web UI
- [ ] E1. Add `requestAttachmentUpload()` and `uploadAttachmentToR2()` to `apps/web/src/lib/api.ts`
- [ ] E2. Add file attachment UI to `TaskSubmitForm.tsx` — file input, attachment list with progress, remove button
- [ ] E3. Track per-file upload progress via XHR `progress` event
- [ ] E4. Disable submit button while uploads in progress
- [ ] E5. Pass attachment references in `submitTask()` call

### Phase F: Infrastructure & Configuration
- [ ] F1. Document R2 S3 credential creation in self-hosting guide
- [ ] F2. Add new env vars to `apps/api/.env.example`
- [ ] F3. Add new secrets to `scripts/deploy/configure-secrets.sh` mapping
- [ ] F4. Update `scripts/deploy/sync-wrangler-config.ts` if needed
- [ ] F5. Document R2 CORS configuration requirements

### Phase G: Tests
- [ ] G1. Unit tests for presigned URL generation service
- [ ] G2. Unit tests for attachment validation in task submit
- [ ] G3. Integration test for request-upload → submit with attachments flow
- [ ] G4. Unit tests for attachment transfer in task runner
- [ ] G5. Component tests for TaskSubmitForm file attachment UI

### Phase H: Cleanup & Documentation
- [ ] H1. Update CLAUDE.md with new feature in Recent Changes
- [ ] H2. Verify lint, typecheck, test, build all pass
- [ ] H3. Update `.env.example` with all new env vars

## Acceptance Criteria

- [ ] User can attach files (up to 20 files, 50MB each, 200MB total) in TaskSubmitForm
- [ ] Files upload directly to R2 with per-file progress indicators
- [ ] Submit button is disabled while uploads are in progress
- [ ] Task submission validates attachment refs exist in R2
- [ ] Task Runner copies attachments from R2 to workspace `.private/` directory after workspace is ready
- [ ] Agent initial prompt includes list of attached files and their paths
- [ ] R2 keys are cleaned up after successful transfer
- [ ] Orphaned uploads are cleaned up by 24h lifecycle rule
- [ ] All size limits are configurable via env vars
- [ ] No hardcoded values (constitution Principle XI compliance)

## References

- `packages/shared/src/types.ts` — SubmitTaskRequest type
- `apps/api/src/routes/tasks/submit.ts` — Task submission endpoint
- `apps/api/src/durable-objects/task-runner.ts` — Task Runner DO
- `apps/web/src/components/task/TaskSubmitForm.tsx` — Task form UI
- `apps/web/src/lib/api.ts` — API client
- `apps/api/wrangler.toml` — R2 binding config
- `infra/resources/storage.ts` — R2 bucket Pulumi resource
- `packages/vm-agent/internal/server/file_transfer.go` — VM agent file upload
