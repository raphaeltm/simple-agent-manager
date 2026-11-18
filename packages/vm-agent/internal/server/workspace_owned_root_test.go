package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestOwnedWorkspaceRootInitializesMissingTrustedBase(t *testing.T) {
	fixture := newDeletionFixture(t)
	base := filepath.Join(t.TempDir(), "fresh-node", "workspace")
	fixture.server.config.WorkspaceDir = base
	root := filepath.Join(base, "new-workspace")
	if err := fixture.server.createOwnedWorkspaceRoot(&WorkspaceRuntime{ID: "new-workspace"}, root); err != nil {
		t.Fatalf("fresh-node root creation failed: %v", err)
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() {
		t.Fatalf("workspace root not created: %v", err)
	}
	payload, err := fixture.server.store.GetOwnedWorkspaceRoot("new-workspace")
	if err != nil {
		t.Fatal(err)
	}
	var proof workspaceDeletionIntent
	if err := json.Unmarshal([]byte(payload), &proof); err != nil {
		t.Fatal(err)
	}
	dev, ino, err := deletionRootIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	if proof.Root != root || proof.RootDevice != dev || proof.RootInode != ino || ino == 0 || proof.NodeID != fixture.server.config.NodeID || proof.NodeRuntimeIncarnationID != fixture.server.config.NodeRuntimeIncarnationID {
		t.Fatalf("fresh root has no exact creation ownership: %+v", proof)
	}
	// An existing directory in the new base must still never be adopted.
	existing := filepath.Join(base, "existing")
	if err := os.Mkdir(existing, 0755); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.createOwnedWorkspaceRoot(&WorkspaceRuntime{ID: "existing"}, existing); err != nil {
		t.Fatal(err)
	}
	if payload, _ := fixture.server.store.GetOwnedWorkspaceRoot("existing"); payload != "" {
		t.Fatal("initializing the base adopted an existing workspace")
	}
}
func TestOwnedWorkspaceRootRefusesSymlinkBaseAndAncestors(t *testing.T) {
	for _, nested := range []bool{false, true} {
		t.Run(map[bool]string{false: "base", true: "ancestor"}[nested], func(t *testing.T) {
			fixture := newDeletionFixture(t)
			outside := t.TempDir()
			link := filepath.Join(t.TempDir(), "linked")
			if err := os.Symlink(outside, link); err != nil {
				t.Fatal(err)
			}
			base := link
			if nested {
				base = filepath.Join(link, "new-base")
			}
			fixture.server.config.WorkspaceDir = base
			root := filepath.Join(base, "new-workspace")
			if err := fixture.server.createOwnedWorkspaceRoot(&WorkspaceRuntime{ID: "new-workspace"}, root); err == nil {
				t.Fatal("symlink ancestor accepted")
			}
			entries, err := os.ReadDir(outside)
			if err != nil || len(entries) != 0 {
				t.Fatalf("unknown symlink target modified: %v %#v", err, entries)
			}
			if payload, _ := fixture.server.store.GetOwnedWorkspaceRoot("new-workspace"); payload != "" {
				t.Fatal("symlink target gained deletion ownership")
			}
		})
	}
}
