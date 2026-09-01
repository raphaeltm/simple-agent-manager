-- Bounded verification and forward-restore cursors for linked immutable R2
-- manifest pages. These columns do not enable archive migration.

ALTER TABLE project_data_archive_migrations ADD COLUMN recovery_verify_page_key TEXT;
ALTER TABLE project_data_archive_migrations ADD COLUMN recovery_verify_page_index INTEGER;
ALTER TABLE project_data_archive_migrations ADD COLUMN recovery_verify_entry_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_data_archive_migrations ADD COLUMN recovery_verify_expected_hash TEXT;
ALTER TABLE project_data_archive_migrations ADD COLUMN recovery_verify_entries_seen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_data_archive_migrations ADD COLUMN recovery_verified_at INTEGER;
ALTER TABLE project_data_archive_migrations ADD COLUMN recovery_restore_page_key TEXT;
ALTER TABLE project_data_archive_migrations ADD COLUMN recovery_restore_page_index INTEGER;
ALTER TABLE project_data_archive_migrations ADD COLUMN recovery_restore_entry_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_data_archive_migrations ADD COLUMN recovery_target_reset_at INTEGER;
ALTER TABLE project_data_archive_migrations ADD COLUMN target_cleanup_at INTEGER;
