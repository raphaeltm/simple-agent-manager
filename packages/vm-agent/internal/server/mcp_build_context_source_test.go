package server

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

func TestContextSourceWorkingDirectorySwap(t *testing.T) {
	for _, standalone := range []bool{false, true} {
		name := "VM"
		if standalone {
			name = "Instant"
		}
		t.Run(name, func(t *testing.T) {
			for _, attack := range []bool{false, true} {
				name := "owner"
				if attack {
					name = "swap"
				}
				t.Run(name, func(t *testing.T) {
					s, _ := mcpBuildTestServer(t)
					s.config.Role = config.RoleWorkspace
					s.config.ContainerMode = true
					mount := t.TempDir()
					work := "/workspaces/work"
					if standalone {
						s.config.Role = config.RoleStandalone
						s.config.ContainerMode = false
						var err error
						mount, err = os.MkdirTemp("/workspaces", "context-source-swap-")
						if err != nil {
							t.Fatal(err)
						}
						t.Cleanup(func() { os.RemoveAll(mount) })
						work = filepath.Join(mount, "work")
					}
					owned := filepath.Join(mount, "work")
					if err := os.Mkdir(owned, 0700); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(owned, "marker"), []byte("OWNER"), 0600); err != nil {
						t.Fatal(err)
					}
					outside := t.TempDir()
					if err := os.WriteFile(filepath.Join(outside, "marker"), []byte("HOST_SECRET"), 0600); err != nil {
						t.Fatal(err)
					}
					docker := filepath.Join(t.TempDir(), "docker")
					if err := os.WriteFile(docker, []byte("#!/bin/sh\necho '"+mount+"'\n"), 0700); err != nil {
						t.Fatal(err)
					}
					t.Setenv("SAM_DOCKER_CLI_PATH", docker)
					root, err := s.openContextSourceDir(context.Background(), "workspace", &WorkspaceRuntime{}, work, func() {
						if !attack {
							return
						}
						if err := os.Rename(owned, owned+"-pinned"); err != nil {
							t.Fatal(err)
						}
						if err := os.Symlink(outside, owned); err != nil {
							t.Fatal(err)
						}
					})
					if attack {
						if root != nil {
							root.Close()
						}
						if err == nil {
							t.Fatal("working-directory swap escaped trusted base")
						}
						return
					}
					if err != nil {
						t.Fatalf("owner control: %v", err)
					}
					defer root.Close()
					data, err := root.ReadFile("marker")
					if err != nil || string(data) != "OWNER" {
						t.Fatalf("owner control: %q %v", data, err)
					}
				})
			}
		})
	}
}

// Isolate the deliberate blocking regression in a killable, reaped subprocess.
// A broken acquisition must not leave a blocked goroutine behind in the suite.
func TestContextSourceRejectsFifo(t *testing.T) {
	for _, runtime := range []string{"VM", "Instant"} {
		for _, mode := range []string{"existing", "swap"} {
			t.Run(runtime+"/"+mode, func(t *testing.T) {
				mount := t.TempDir()
				if runtime == "Instant" {
					var err error
					mount, err = os.MkdirTemp("/workspaces", "context-source-fifo-")
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() { os.RemoveAll(mount) })
				}
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestContextSourceFifoHelper$")
				cmd.Env = append(os.Environ(), "SAM_TEST_CONTEXT_FIFO_RUNTIME="+runtime, "SAM_TEST_CONTEXT_FIFO_MODE="+mode, "SAM_TEST_CONTEXT_FIFO_MOUNT="+mount, "TMPDIR="+t.TempDir())
				out, err := cmd.CombinedOutput()
				if ctx.Err() != nil {
					t.Fatalf("source acquisition blocked on FIFO: %v", ctx.Err())
				}
				if err != nil {
					t.Fatalf("FIFO helper: %v: %s", err, out)
				}
			})
		}
	}
}
func TestContextSourceFifoHelper(t *testing.T) {
	runtime := os.Getenv("SAM_TEST_CONTEXT_FIFO_RUNTIME")
	if runtime == "" {
		t.Skip("subprocess helper")
	}
	s, _ := mcpBuildTestServer(t)
	s.config.Role = config.RoleWorkspace
	mount := os.Getenv("SAM_TEST_CONTEXT_FIFO_MOUNT")
	if mount == "" {
		t.Fatal("parent fixture mount required")
	}
	work := "/workspaces/work"
	if runtime == "Instant" {
		s.config.Role = config.RoleStandalone
		work = filepath.Join(mount, "work")
	}

	owned := filepath.Join(mount, "work")
	if err := os.Mkdir(owned, 0700); err != nil {
		t.Fatal(err)
	}
	replace := func() {
		if err := os.Rename(owned, owned+"-pinned"); err != nil {
			t.Fatal(err)
		}
		if err := syscall.Mkfifo(owned, 0600); err != nil {
			t.Fatal(err)
		}
	}
	docker := filepath.Join(t.TempDir(), "docker")
	if err := os.WriteFile(docker, []byte("#!/bin/sh\necho '"+mount+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SAM_DOCKER_CLI_PATH", docker)
	var hook func()
	if os.Getenv("SAM_TEST_CONTEXT_FIFO_MODE") == "existing" {
		replace()
	} else {
		hook = replace
	}
	root, err := s.openContextSourceDir(context.Background(), "workspace", &WorkspaceRuntime{}, work, hook)
	if root != nil {
		root.Close()
	}
	if err == nil {
		t.Fatal("FIFO accepted as source directory")
	}
}
