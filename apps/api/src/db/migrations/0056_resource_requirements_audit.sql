-- Migration 0055: Add resource requirement audit columns to tasks and workspaces
-- Phase 0/1 of resource profiles — audit-only, no placement behavior change.
-- All columns are nullable TEXT to store JSON snapshots for observability.

-- Tasks: record what was requested and how it was resolved
ALTER TABLE tasks ADD COLUMN requested_vm_size TEXT;
ALTER TABLE tasks ADD COLUMN requested_vm_size_source TEXT;
ALTER TABLE tasks ADD COLUMN resource_requirements_json TEXT;
ALTER TABLE tasks ADD COLUMN resource_requirements_source TEXT;
ALTER TABLE tasks ADD COLUMN resolved_reservation_json TEXT;
ALTER TABLE tasks ADD COLUMN placement_explanation_json TEXT;

-- Workspaces: record the resource intent that drove workspace creation
ALTER TABLE workspaces ADD COLUMN resource_requirements_json TEXT;
ALTER TABLE workspaces ADD COLUMN resolved_reservation_json TEXT;
ALTER TABLE workspaces ADD COLUMN placement_explanation_json TEXT;
