package transferscratch

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestScratchLeaseProcessHelper(t *testing.T) {
	root := os.Getenv("SAM_SCRATCH_TEST_ROOT")
	if root == "" {
		t.Skip("subprocess fixture")
	}
	c := Config{Root: root, Retention: time.Hour, MaxEntries: 64, MaxFiles: 128, MaxReclaimBytes: 1 << 20}
	op, err := New(c, "publish")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(op.Path, "web.tar"), []byte("in flight"), 0600); err != nil {
		t.Fatal(err)
	}
	fmt.Println(op.Path)
	for {
		time.Sleep(time.Hour)
	} // parent kills the process to model a crash
}

func TestRealProcessCrashReleasesTransferLease(t *testing.T) {
	c := testConfig(t)
	c.DryRun = false
	cmd := exec.Command(os.Args[0], "-test.run=^TestScratchLeaseProcessHelper$")
	cmd.Env = append(os.Environ(), "SAM_SCRATCH_TEST_ROOT="+c.Root)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	ready := bufio.NewScanner(stdout)
	if !ready.Scan() || !strings.HasPrefix(ready.Text(), c.Root) {
		t.Fatal("subprocess failed to create transfer")
	}
	r, err := Sweep(context.Background(), c, time.Now().Add(48*time.Hour))
	if err != nil || r.Protected != 1 || r.Removed != 0 {
		t.Fatalf("process lease lost %+v %v", r, err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	r, err = Sweep(context.Background(), c, time.Now().Add(48*time.Hour))
	if err != nil || r.Removed != 1 {
		t.Fatalf("crash recovery %+v %v", r, err)
	}
}

func TestMountedArchiveProtected(t *testing.T) {
	c := testConfig(t)
	c.DryRun = false
	path := abandoned(t, c)
	outside := filepath.Join(t.TempDir(), "outside.tar")
	if err := os.WriteFile(outside, []byte("user data"), 0600); err != nil {
		t.Fatal(err)
	}
	mount := filepath.Join(path, "api.tar")
	if err := syscall.Mount(outside, mount, "", syscall.MS_BIND, ""); err != nil {
		t.Skipf("bind mounts unavailable: %v", err)
	}
	defer syscall.Unmount(mount, 0)
	r, err := Sweep(context.Background(), c, time.Now().Add(48*time.Hour))
	if err != nil || r.Protected != 1 || r.Removed != 0 {
		t.Fatalf("mounted archive %+v %v", r, err)
	}
	if bytes, err := os.ReadFile(outside); err != nil || string(bytes) != "user data" {
		t.Fatalf("mounted source changed %q %v", bytes, err)
	}
}

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
