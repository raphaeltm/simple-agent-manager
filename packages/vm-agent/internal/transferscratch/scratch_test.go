package transferscratch

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	scanState.Lock()
	if scanState.dir != nil {
		scanState.dir.Close()
		scanState.dir = nil
	}
	scanState.Unlock()
	t.Cleanup(func() {
		scanState.Lock()
		defer scanState.Unlock()
		if scanState.dir != nil {
			scanState.dir.Close()
			scanState.dir = nil
		}
	})
	return Config{Root: filepath.Join(t.TempDir(), "transfers"), Retention: time.Hour, MaxEntries: 64, MaxFiles: 128, MaxReclaimBytes: 1 << 20, DryRun: true}
}

func abandoned(t *testing.T, c Config) string {
	t.Helper()
	op, err := New(c, "publish")
	if err != nil {
		t.Fatal(err)
	}
	path := op.Path
	if err := os.WriteFile(filepath.Join(path, "api.tar"), []byte("image archive"), 0600); err != nil {
		t.Fatal(err)
	}
	op.release() // models process death: releases lease without deleting files
	return path
}

func TestRecoveryDryRunAndExplicitApply(t *testing.T) {
	c := testConfig(t)
	path := abandoned(t, c)
	now := time.Now().Add(2 * time.Hour)
	r, err := Sweep(context.Background(), c, now)
	if err != nil || r.Candidates != 1 || r.Removed != 0 || r.CandidateBytes == 0 {
		t.Fatalf("dry run: %+v %v", r, err)
	}
	if _, err := os.Stat(filepath.Join(path, "api.tar")); err != nil {
		t.Fatal("dry run removed archive", err)
	}
	c.DryRun = false
	r, err = Sweep(context.Background(), c, now)
	if err != nil || r.Removed != 1 || r.ReclaimedBytes == 0 {
		t.Fatalf("cleanup: %+v %v", r, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("scratch still exists: %v", err)
	}
	r, err = Sweep(context.Background(), c, now)
	if err != nil || r.Removed != 0 {
		t.Fatalf("duplicate sweep: %+v %v", r, err)
	}
}

func TestLiveOperationProtectedDespiteAgeAndSecondSweep(t *testing.T) {
	c := testConfig(t)
	c.DryRun = false
	op, err := New(c, "deploy")
	if err != nil {
		t.Fatal(err)
	}
	defer op.Close()
	if err := os.WriteFile(filepath.Join(op.Path, "web.tar"), []byte("active download"), 0600); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		r, err := Sweep(context.Background(), c, time.Now().Add(48*time.Hour))
		if err != nil || r.Protected != 1 || r.Removed != 0 {
			t.Fatalf("live operation: %+v %v", r, err)
		}
		if _, err := os.Stat(filepath.Join(op.Path, "web.tar")); err != nil {
			t.Fatal("active data lost", err)
		}
	}
}

func TestUnknownLinksDirectoriesAndUserCachesPreserved(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "nested", "unknown-file", "invalid-marker"} {
		t.Run(kind, func(t *testing.T) {
			c := testConfig(t)
			c.DryRun = false
			path := abandoned(t, c)
			outside := filepath.Join(t.TempDir(), "user-cache.tar")
			if err := os.WriteFile(outside, []byte("user state"), 0600); err != nil {
				t.Fatal(err)
			}
			var err error
			switch kind {
			case "symlink":
				err = os.Symlink(outside, filepath.Join(path, "linked.tar"))
			case "hardlink":
				err = os.Link(outside, filepath.Join(path, "linked.tar"))
			case "nested":
				err = os.Mkdir(filepath.Join(path, "nested-docker-volume"), 0700)
			case "unknown-file":
				err = os.WriteFile(filepath.Join(path, "user.txt"), []byte("unknown"), 0600)
			case "invalid-marker":
				err = os.WriteFile(filepath.Join(path, ownerFile), []byte(`{"version":999}`), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			r, err := Sweep(context.Background(), c, time.Now().Add(48*time.Hour))
			if err != nil || r.Protected != 1 || r.Removed != 0 {
				t.Fatalf("protected: %+v %v", r, err)
			}
			if data, err := os.ReadFile(outside); err != nil || string(data) != "user state" {
				t.Fatalf("external state changed: %q %v", data, err)
			}
			if _, err := os.Stat(filepath.Join(path, "api.tar")); err != nil {
				t.Fatal("partial deletion before validation", err)
			}
		})
	}
}

func TestUnmarkedLegacyScratchAndUnrelatedTreePreserved(t *testing.T) {
	c := testConfig(t)
	c.DryRun = false
	if err := os.MkdirAll(filepath.Join(c.Root, "op-publish-old"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(c.Root, "user-cache"), 0700); err != nil {
		t.Fatal(err)
	}
	r, err := Sweep(context.Background(), c, time.Now().Add(48*time.Hour))
	if err != nil || r.Protected != 2 || r.Removed != 0 {
		t.Fatalf("legacy: %+v %v", r, err)
	}
}

func TestBoundedInventoryAdvancesPastProtectedEntries(t *testing.T) {
	c := testConfig(t)
	c.DryRun = false
	c.MaxEntries = 1
	paths := []string{abandoned(t, c), abandoned(t, c), abandoned(t, c)}
	removed := 0
	for range 5 {
		r, err := Sweep(context.Background(), c, time.Now().Add(48*time.Hour))
		if err != nil || r.Scanned > 1 {
			t.Fatalf("bounded %+v %v", r, err)
		}
		removed += r.Removed
	}
	if removed != len(paths) {
		t.Fatalf("iterator stranded entries: removed %d", removed)
	}
}

func TestByteAndFileBudgetProtectsWholeOperation(t *testing.T) {
	for _, budget := range []string{"bytes", "files"} {
		t.Run(budget, func(t *testing.T) {
			c := testConfig(t)
			c.DryRun = false
			path := abandoned(t, c)
			if budget == "bytes" {
				c.MaxReclaimBytes = 1
			} else {
				c.MaxFiles = 2
			}
			r, err := Sweep(context.Background(), c, time.Now().Add(48*time.Hour))
			if err != nil || r.Removed != 0 || r.Protected != 1 {
				t.Fatalf("budget %+v %v", r, err)
			}
			if _, err := os.Stat(filepath.Join(path, "api.tar")); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDefaultDryRunAndInvalidConfigurationFailClosed(t *testing.T) {
	t.Setenv("SAM_IMAGE_TRANSFER_SCRATCH_DRY_RUN", "")
	c, err := ConfigFromEnvironment()
	if err != nil || !c.DryRun {
		t.Fatalf("defaults %+v %v", c, err)
	}
	t.Setenv("SAM_IMAGE_TRANSFER_SCRATCH_DRY_RUN", "typo")
	if _, err := ConfigFromEnvironment(); err == nil {
		t.Fatal("malformed dry-run must fail closed")
	}
}

func TestSymlinkRootRejectedAndNormalCloseCleansOwnFiles(t *testing.T) {
	c := testConfig(t)
	op, err := New(c, "deploy")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(op.Path, "web.tar"), []byte("archive"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := op.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(op.Path); !os.IsNotExist(err) {
		t.Fatalf("normal operation leaked: %v", err)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(c.Root, alias); err != nil {
		t.Fatal(err)
	}
	c.Root = alias
	if _, err := New(c, "deploy"); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlink root accepted: %v", err)
	}
}
