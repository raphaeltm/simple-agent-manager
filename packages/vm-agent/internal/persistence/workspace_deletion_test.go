package persistence

import (
	"path/filepath"
	"testing"
	"time"
)

func TestWorkspaceDeletionTombstoneRetentionIsBoundedAndKeepsPending(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "deletions.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for _, id := range []string{"old-1", "old-2", "old-3"} {
		if err := store.PutWorkspaceDeletion(id, `{"finalized":true}`); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.PutWorkspaceDeletion("pending", `{"finalized":false}`); err != nil {
		t.Fatal(err)
	}
	if err := store.PutWorkspaceDeletion("recent", `{"finalized":true}`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE workspace_deletions SET updated_at=? WHERE workspace_id='recent'`, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	removed, err := store.PruneFinalizedWorkspaceDeletions(time.Now().Add(-7*24*time.Hour), 2)
	if err != nil || removed != 2 {
		t.Fatalf("removed=%d err=%v", removed, err)
	}
	for _, id := range []string{"pending", "recent", "old-3"} {
		if payload, err := store.GetWorkspaceDeletion(id); err != nil || payload == "" {
			t.Fatalf("protected/unbounded row removed %s: %v", id, err)
		}
	}
	removed, err = store.PruneFinalizedWorkspaceDeletions(time.Now().Add(-7*24*time.Hour), 2)
	if err != nil || removed != 1 {
		t.Fatalf("second removed=%d err=%v", removed, err)
	}
	if payload, _ := store.GetWorkspaceDeletion("pending"); payload == "" {
		t.Fatal("unfinished intent pruned")
	}
}
