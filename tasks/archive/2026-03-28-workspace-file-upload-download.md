# Workspace File Upload/Download

**Created**: 2026-03-28
**Completed**: 2026-03-28

## Summary

Added file upload and download capabilities to workspace sessions, enabling users to attach files to chat conversations and download files from the workspace.

## Changes

- VM agent: `file_transfer.go` with upload (multipart + docker exec tee) and download (docker exec cat) handlers
- VM agent: Config fields for file transfer size/timeout limits
- API: Upload and download proxy routes in `files.ts`
- Web: Paperclip attach button in FollowUpInput, download button in ChatFilePanel
- Bootstrap: `.private` directory creation in `ensureVolumeWritable`
- Backlog task for migrating token from query param to auth header
