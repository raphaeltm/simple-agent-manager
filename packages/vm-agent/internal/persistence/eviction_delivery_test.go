package persistence

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func evictionDeliveryFixture() EvictionDelivery {
	return EvictionDelivery{WorkspaceID: "workspace-1", ProjectID: "project-1", NodeID: "node-1", ContainerID: "container-1",
		Generation: "run-1", Reason: "memory_pressure", OccurredAt: time.Now().Add(-time.Minute).UTC()}
}

func TestEvictionIntentSurvivesRestartAndFinalizationIsAtomic(t *testing.T) {
	path := filepath.Join(t.TempDir(), "eviction.db")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertWorkspaceMetadata(WorkspaceMetadata{WorkspaceID: "workspace-1", EvictionGeneration: "run-1"}); err != nil {
		t.Fatal(err)
	}
	d := evictionDeliveryFixture()
	if applied, err := store.RecordWorkspaceEviction(context.Background(), d); err != nil || !applied {
		t.Fatalf("prepare=%v,%v", applied, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	meta, err := store.GetWorkspaceMetadata(d.WorkspaceID)
	if err != nil || meta == nil || !meta.Evicted {
		t.Fatalf("metadata=%#v err=%v", meta, err)
	}
	claimed, err := store.ClaimEvictionDelivery(context.Background(), "", time.Now(), time.Second, time.Minute, time.Second)
	if err != nil || claimed == nil || claimed.ContainerStopped {
		t.Fatalf("intent=%#v err=%v", claimed, err)
	}
	d.ContainerStopped, d.SnapshotCaptured = true, true
	if applied, err := store.RecordWorkspaceEviction(context.Background(), d); err != nil || !applied {
		t.Fatalf("finalize=%v,%v", applied, err)
	}
	ready, err := store.ClaimEvictionDelivery(context.Background(), "", time.Now().Add(time.Minute), time.Second, time.Minute, time.Second)
	if err != nil || ready == nil || !ready.ContainerStopped || !ready.SnapshotCaptured {
		t.Fatalf("ready=%#v err=%v", ready, err)
	}
	if err := store.CompleteEvictionDelivery(context.Background(), ready.ID, ready.Attempts, ready.PayloadRevision); err != nil {
		t.Fatal(err)
	}
	got, err := store.ClaimEvictionDelivery(context.Background(), "", time.Now().Add(time.Hour), time.Second, time.Minute, time.Second)
	if err != nil || got != nil {
		t.Fatalf("acknowledged row=%#v err=%v", got, err)
	}
}

func TestEvictionOutboxRejectsStaleGenerationAndRollsBackMarker(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "eviction.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpsertWorkspaceMetadata(WorkspaceMetadata{WorkspaceID: "workspace-1", EvictionGeneration: "run-2"}); err != nil {
		t.Fatal(err)
	}
	d := evictionDeliveryFixture()
	if applied, err := store.RecordWorkspaceEviction(context.Background(), d); err != nil || applied {
		t.Fatalf("stale apply=%v err=%v", applied, err)
	}
	d.Generation, d.Reason = "run-2", "invalid"
	if applied, err := store.RecordWorkspaceEviction(context.Background(), d); err == nil || applied {
		t.Fatalf("invalid apply=%v err=%v", applied, err)
	}
	meta, err := store.GetWorkspaceMetadata(d.WorkspaceID)
	if err != nil || meta == nil || meta.Evicted {
		t.Fatalf("failed transaction changed marker: %#v %v", meta, err)
	}
}

func TestEvictionDeliveryBackoffLeaseAndAckAreBounded(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "eviction.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpsertWorkspaceMetadata(WorkspaceMetadata{WorkspaceID: "workspace-1", EvictionGeneration: "run-1"}); err != nil {
		t.Fatal(err)
	}
	d := evictionDeliveryFixture()
	if _, err := store.RecordWorkspaceEviction(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	first, err := store.ClaimEvictionDelivery(context.Background(), "", now, time.Second, 4*time.Second, 2*time.Second)
	if err != nil || first == nil || !first.NextAttemptAt.Equal(now.Add(2*time.Second)) {
		t.Fatalf("claim=%#v err=%v", first, err)
	}
	if got, err := store.ClaimEvictionDelivery(context.Background(), "", now.Add(time.Second), time.Second, 4*time.Second, 2*time.Second); err != nil || got != nil {
		t.Fatalf("duplicate lease=%#v %v", got, err)
	}
	second, err := store.ClaimEvictionDelivery(context.Background(), "", now.Add(2*time.Second), time.Second, 4*time.Second, 2*time.Second)
	if err != nil || second == nil {
		t.Fatalf("retry=%#v err=%v", second, err)
	}
	if err := store.CompleteEvictionDelivery(context.Background(), first.ID, first.Attempts, first.PayloadRevision); err != nil {
		t.Fatal(err)
	}
	third, err := store.ClaimEvictionDelivery(context.Background(), "", now.Add(time.Hour), time.Second, 4*time.Second, 2*time.Second)
	if err != nil || third == nil || third.Attempts != 3 {
		t.Fatalf("old ack removed newer lease: %#v %v", third, err)
	}
	if got := evictionRetryDelay(1<<30, time.Second, time.Minute); got != time.Minute {
		t.Fatalf("unbounded retry delay=%s", got)
	}
}

func TestEvictionDeliveryCompletionIsFencedByPayloadRevision(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "eviction.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpsertWorkspaceMetadata(WorkspaceMetadata{WorkspaceID: "workspace-1", EvictionGeneration: "run-1"}); err != nil {
		t.Fatal(err)
	}
	d := evictionDeliveryFixture()
	if _, err := store.RecordWorkspaceEviction(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	stale, err := store.ClaimEvictionDelivery(context.Background(), "", now, time.Minute, time.Minute, time.Minute)
	if err != nil || stale == nil || stale.PayloadRevision != 0 {
		t.Fatalf("stale claim=%#v err=%v", stale, err)
	}
	d.ContainerStopped, d.SnapshotCaptured = true, true
	if applied, err := store.RecordWorkspaceEviction(context.Background(), d); err != nil || !applied {
		t.Fatalf("upgrade=%v,%v", applied, err)
	}
	if err := store.CompleteEvictionDelivery(context.Background(), stale.ID, stale.Attempts, stale.PayloadRevision); err != nil {
		t.Fatal(err)
	}
	upgraded, err := store.ClaimEvictionDelivery(context.Background(), "", now.Add(time.Millisecond), time.Minute, time.Minute, time.Minute)
	if err != nil || upgraded == nil {
		t.Fatalf("upgraded claim=%#v err=%v", upgraded, err)
	}
	if !upgraded.ContainerStopped || !upgraded.SnapshotCaptured || upgraded.PayloadRevision != 1 {
		t.Fatalf("stale completion deleted upgraded payload: %#v", upgraded)
	}
}
