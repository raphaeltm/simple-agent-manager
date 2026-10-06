package persistence

import (
	"database/sql"
	"testing"
)

func TestWorkspaceEvictionGenerationMigrationPreservesLegacyMetadata(t *testing.T) {
	path := tempDBPath(t)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range []func(*sql.DB) error{migrateV1, migrateV2, migrateV3, migrateV4, migrateV5, migrateV6, migrateV7, migrateV8, migrateV9, migrateV10, migrateV11, migrateV12, migrateV13} {
		if err := migration(db); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (13); INSERT INTO workspace_metadata (workspace_id, repository, container_work_dir, callback_token, chat_session_id, updated_at) VALUES ('ws-legacy', 'owner/repo', '/workspaces/repo', 'legacy-callback', 'chat-legacy', '2026-09-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	meta, err := store.GetWorkspaceMetadata("ws-legacy")
	if err != nil {
		t.Fatal(err)
	}
	if meta == nil || meta.EvictionGeneration != "" || meta.Evicted || meta.Repository != "owner/repo" || meta.CallbackToken != "legacy-callback" || meta.ChatSessionID != "chat-legacy" || meta.ContainerWorkDir != "/workspaces/repo" {
		t.Fatalf("legacy metadata changed: %#v", meta)
	}
}

func TestWorkspaceEvictionGenerationCASResistsStaleMetadataAndReloads(t *testing.T) {
	path := tempDBPath(t)
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	stale := WorkspaceMetadata{WorkspaceID: "ws-fence", Repository: "owner/repo", ProjectID: "project-1", ChatSessionID: "chat-1", Evicted: true}
	if err := store.UpsertWorkspaceMetadata(stale); err != nil {
		t.Fatal(err)
	}
	const first = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
	const second = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
	for _, transition := range []struct {
		old, next string
		want      bool
	}{
		{"", first, true}, {"", second, false}, {first, second, true}, {first, first, false},
	} {
		got, err := store.CompareAndSwapWorkspaceEvictionGeneration("ws-fence", transition.old, transition.next)
		if err != nil || got != transition.want {
			t.Fatalf("CAS %+v: %v, %v", transition, got, err)
		}
	}
	for _, old := range []string{"", first, "unrelated-stale-token"} {
		stale.EvictionGeneration = old
		stale.ProjectID = "unrelated-stale-project"
		if err := store.UpsertWorkspaceMetadata(stale); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	meta, err := store.GetWorkspaceMetadata("ws-fence")
	if err != nil || meta == nil || meta.EvictionGeneration != second || meta.Evicted || meta.ProjectID != "project-1" || meta.ChatSessionID != "chat-1" {
		t.Fatalf("durable generation lost: %#v, %v", meta, err)
	}
	if changed, err := store.CompareAndSwapWorkspaceEvictionGeneration("missing", "", first); err != nil || changed {
		t.Fatalf("missing metadata changed: %v, %v", changed, err)
	}
}
